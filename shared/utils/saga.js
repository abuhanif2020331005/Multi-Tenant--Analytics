/**
 * Saga orchestrator for multi-step distributed transactions.
 *
 * Each step has an execute() and compensate() function.
 * If any step fails, all previously completed steps are compensated
 * in reverse order (rollback).
 *
 * Usage:
 *   const saga = createSaga('create-order', logger);
 *   saga.addStep('reserve-inventory', reserveFn, releaseFn);
 *   saga.addStep('charge-payment',    chargeFn,  refundFn);
 *   saga.addStep('emit-event',        emitFn,    null);
 *   const result = await saga.execute(context);
 */

function createSaga(name, logger = null) {
  const steps = [];

  function addStep(stepName, execute, compensate = null) {
    steps.push({ stepName, execute, compensate });
    return { addStep, execute: runSaga };
  }

  async function runSaga(context = {}) {
    const completed = [];
    const results = {};

    logger?.info('saga_started', { saga: name, steps: steps.map((s) => s.stepName) });

    for (const step of steps) {
      try {
        logger?.info('saga_step_executing', { saga: name, step: step.stepName });
        const result = await step.execute(context, results);
        results[step.stepName] = result;
        completed.push(step);
        logger?.info('saga_step_completed', { saga: name, step: step.stepName });
      } catch (error) {
        logger?.error('saga_step_failed', {
          saga: name,
          step: step.stepName,
          error: error.message,
          compensating: completed.length,
        });

        // Compensate in reverse order
        const compensationErrors = [];
        for (const completedStep of [...completed].reverse()) {
          if (!completedStep.compensate) continue;
          try {
            logger?.info('saga_compensating', { saga: name, step: completedStep.stepName });
            await completedStep.compensate(context, results);
            logger?.info('saga_compensated', { saga: name, step: completedStep.stepName });
          } catch (compensationError) {
            logger?.error('saga_compensation_failed', {
              saga: name,
              step: completedStep.stepName,
              error: compensationError.message,
            });
            compensationErrors.push({ step: completedStep.stepName, error: compensationError.message });
          }
        }

        const sagaError = new Error(
          `Saga [${name}] failed at step [${step.stepName}]: ${error.message}`
        );
        sagaError.sagaName = name;
        sagaError.failedStep = step.stepName;
        sagaError.originalError = error;
        sagaError.compensationErrors = compensationErrors;
        throw sagaError;
      }
    }

    logger?.info('saga_completed', { saga: name, steps: Object.keys(results) });
    return results;
  }

  return { addStep, execute: runSaga };
}

module.exports = { createSaga };
