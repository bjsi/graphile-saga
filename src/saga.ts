import { Job, JobHelpers } from "graphile-worker";
import { createTask, TypedTask, AddJobFn } from "graphile-worker-zod";
import { ZodTypeAny, z } from "zod";

type TaskNamePayloadMaps<
  TaskListType extends Record<string, TypedTask<any, any>>
> = {
  [Name in keyof TaskListType]: Parameters<TaskListType[Name]>[0];
};

type KeysWithoutBar<T extends Record<string, any>> = {
  [K in keyof T]: K extends `${infer _Start}|${infer _End}` ? never : K;
}[keyof T];
/**
 * This is a function you can use to get a addJob function typed
 * to prevent you from accidentally queueing an intermediate
 * step to a saga
 */
type SagaTolerantAddJobFn<
  TaskListType extends Record<string, TypedTask<any, any>>
> = <Name extends KeysWithoutBar<TaskListType>>(
  name: Name,
  payload: TaskNamePayloadMaps<TaskListType>[Name]
) => Promise<Job>;

export { SagaTolerantAddJobFn as AddJobFn };

type SagaJobHelpers = JobHelpers & {
  cancel: (reason?: string) => void;
};

class CancelError extends Error {}

const makeSagaJobHelpers = (helpers: JobHelpers): SagaJobHelpers => {
  return {
    ...helpers,
    cancel: (reason?: string) => {
      throw new CancelError(reason);
    },
  };
};

type Step<
  PriorSteps extends PriorStepsTemplate,
  StepResult,
  StepName extends string,
  InitialPayload
> = {
  name: StepName;
  run: (
    initialPayload: InitialPayload,
    priorResults: PriorResultsPayload<PriorSteps>,
    helpers: SagaJobHelpers
  ) => Promise<StepResult>;
  cancel?: (
    initialPayload: InitialPayload,
    priorResults: PriorResultsPayload<PriorSteps>,
    runResult: StepResult,
    helpers: JobHelpers
  ) => Promise<unknown>;
};

type StepTemplate = Step<any, any, any, any>;

type PriorStepsTemplate = Record<string, StepTemplate>;

type PriorResultsPayload<PriorSteps extends PriorStepsTemplate> = {
  [key in keyof PriorSteps]: Awaited<ReturnType<PriorSteps[key]["run"]>>;
};

type GetTaskList<
  SagaName extends string,
  PriorSteps extends PriorStepsTemplate
> = Record<SagaName, TypedTask<unknown, unknown>> &
  Record<
    `${SagaName}|${keyof PriorSteps & string}`,
    TypedTask<unknown, unknown>
  > &
  Record<
    `${SagaName}|${keyof PriorSteps & string}|cancel`,
    TypedTask<unknown, unknown>
  >;

type AddStepToPriorSteps<
  PriorSteps extends PriorStepsTemplate,
  StepName extends string,
  StepResult,
  InitialPayload
> = PriorSteps & {
  [stepName in StepName]: Step<
    PriorSteps,
    StepResult,
    StepName,
    InitialPayload
  >;
};

type Saga<
  SagaName extends string,
  InitialPayload extends ZodTypeAny,
  PriorSteps extends PriorStepsTemplate
> = {
  name: SagaName;
  addStep: <NextStepName extends string, NextStepResult>(
    step: Step<
      PriorSteps,
      NextStepResult,
      NextStepName,
      z.infer<InitialPayload>
    >
  ) => Saga<
    SagaName,
    InitialPayload,
    AddStepToPriorSteps<
      PriorSteps,
      NextStepName,
      NextStepResult,
      z.infer<InitialPayload>
    >
  >;
  getTaskList: () => GetTaskList<SagaName, PriorSteps>;
};

const wrappedRunPayloadSchema = z.object({
  initialPayload: z.any(),
  previousResults: z.record(z.any()),
});

const wrappedCancelPayloadSchema = z.object({
  initialPayload: z.any(),
  previousResults: z.record(z.any()),
  runResult: z.any(),
});

export const createSaga = <
  SagaName extends string,
  InitialPayload extends ZodTypeAny
>(
  name: SagaName,
  initialPayload: InitialPayload
): Saga<SagaName, InitialPayload, {}> => {
  const sagaName = name;
  const steps: StepTemplate[] = [];

  const addStep = (step: StepTemplate) => {
    steps.push(step);
    return { name: sagaName, addStep, getTaskList };
  };

  const getTaskList = () => {
    const firstStep = steps[0];

    const wrapRun = (
      stepIdx: number,
      run: StepTemplate["run"]
    ): TypedTask<unknown, void> => {
      return async (payload: unknown, helpers: JobHelpers) => {
        const { initialPayload, previousResults } =
          stepIdx === 0
            ? { initialPayload: payload, previousResults: {} }
            : wrappedRunPayloadSchema.parse(payload);

        const helpersWithCancel = makeSagaJobHelpers(helpers);

        try {
          const stepExecutionResult = await run(
            initialPayload,
            previousResults,
            helpersWithCancel
          );

          const accumulatedResults = Object.assign({}, previousResults, {
            [steps[stepIdx].name]: stepExecutionResult,
          });

          // If there's a next step, queue it
          const nextStep = steps[stepIdx + 1];
          if (nextStep) {
            const nextJobName = `${sagaName}|${nextStep.name}`;
            await helpers.addJob(nextJobName, {
              initialPayload,
              previousResults: accumulatedResults,
            });
          }

          // If next step is null, the saga is done!
        } catch (ex) {
          if (ex instanceof CancelError) {
            // If there's a prior step, queue its cancel function
            const stepsUntilMeReversed = steps.slice(0, stepIdx).reverse();

            const closestPriorStepWithCancel = stepsUntilMeReversed.find(
              (step) => typeof step.cancel === "function"
            );

            if (closestPriorStepWithCancel) {
              const priorJobCancelName = `${sagaName}|${closestPriorStepWithCancel.name}|cancel`;

              // For easier DX, we find the prior step's result and pass it to the cancel function separately
              const priorStepResult =
                previousResults[closestPriorStepWithCancel.name];

              await helpers.addJob(priorJobCancelName, {
                initialPayload,
                previousResults: previousResults,
                runResult: priorStepResult,
              });
            } else {
              // If there's no prior cancel function, we need to throw - you can't cancel the first step
              // or a step that doesn't have a cancel function before it
              throw new Error(
                `Unexpected cancellation triggered in step ${steps[stepIdx].name}. You can't call cancel with nothing before to cancel!`
              );
            }
          } else {
            // Throw the error normally - graphile-worker's default behavior is to retry nicely, which is good
            // a normal error is not a reason to cascade cancelling up - we should just retry
            throw ex;
          }
        }
      };
    };

    const wrapCancel = (
      stepIdx: number,
      cancel: StepTemplate["cancel"]
    ): TypedTask<unknown, void> => {
      return async (payload: unknown, helpers: JobHelpers) => {
        if (!cancel) {
          throw new Error(
            `Tried to cancel step ${steps[stepIdx].name} but it has no cancel function.  This is probably a mistake in graphile-saga itself, or you have re-deployed graphile-saga without a cancel function that your database still requires.`
          );
        }

        const { initialPayload, previousResults, runResult } =
          wrappedCancelPayloadSchema.parse(payload);

        await cancel(initialPayload, previousResults, runResult, helpers);

        // If there's a prior step, queue its cancel function
        const closestPriorStepWithCancel = steps
          .slice(0, stepIdx)
          .reverse()
          .find((step) => !!step.cancel);

        if (closestPriorStepWithCancel) {
          const priorJobCancelName = `${sagaName}|${closestPriorStepWithCancel.name}|cancel`;

          // For easier DX, we find the prior step's result and pass it to the cancel function separately
          const priorStepResult =
            previousResults[closestPriorStepWithCancel.name];

          await helpers.addJob(priorJobCancelName, {
            initialPayload,
            previousResults: previousResults,
            runResult: priorStepResult,
          });
        }

        // If there's no prior cancel function, we're done!
      };
    };

    const taskList = {
      [sagaName]: createTask(initialPayload, wrapRun(0, firstStep.run)), // TODO - wrap firstStep.run
    };

    steps.forEach((step, idx) => {
      const runKey = `${sagaName}|${step.name}`;
      const cancelKey = `${sagaName}|${step.name}|cancel`;

      const runTask = wrapRun(idx, step.run);
      const cancelTask = wrapCancel(idx, step.cancel);

      taskList[runKey] = runTask;
      taskList[cancelKey] = cancelTask;
    });

    return taskList;
  };

  return {
    name: sagaName,
    addStep: addStep as Saga<SagaName, InitialPayload, {}>["addStep"],
    getTaskList: getTaskList as Saga<
      SagaName,
      InitialPayload,
      {}
    >["getTaskList"],
  };
};
