/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type {
  ConcreteTaskInstance,
  TaskManagerSetupContract,
  TaskManagerStartContract,
} from '@kbn/task-manager-plugin/server';
import type { EndpointAppContext } from '../../types';
import { getArtifactId, reportErrors } from './common';
import type { InternalArtifactCompleteSchema } from '../../schemas/artifacts';
import type { Manifest } from './manifest';
import { isEmptyManifestDiff } from './manifest';
import { InvalidInternalManifestError } from '../../services/artifacts/errors';
import { ManifestManager } from '../../services';
import { wrapErrorIfNeeded } from '../../utils';
import { EndpointError } from '../../../../common/endpoint/errors';

export const ManifestTaskConstants = {
  /**
   * No longer used. Timeout value now comes from `xpack.securitySolution.packagerTaskTimeout`
   * @deprecated
   */
  TIMEOUT: '1m',
  TYPE: 'endpoint:user-artifact-packager',
  VERSION: '1.0.0',
};

export interface ManifestTaskSetupContract {
  endpointAppContext: EndpointAppContext;
  taskManager: TaskManagerSetupContract;
}

export interface ManifestTaskStartContract {
  taskManager: TaskManagerStartContract;
}

export class ManifestTask {
  private endpointAppContext: EndpointAppContext;
  private logger: Logger;
  private wasStarted: boolean = false;

  constructor(setupContract: ManifestTaskSetupContract) {
    this.endpointAppContext = setupContract.endpointAppContext;
    this.logger = this.endpointAppContext.logFactory.get(this.getTaskId());
    const { packagerTaskInterval, packagerTaskTimeout, packagerTaskPackagePolicyUpdateBatchSize } =
      this.endpointAppContext.serverConfig;

    this.logger.info(
      `Registering ${ManifestTaskConstants.TYPE} task with timeout of [${packagerTaskTimeout}], interval of [${packagerTaskInterval}] and policy update batch size of [${packagerTaskPackagePolicyUpdateBatchSize}]`
    );

    setupContract.taskManager.registerTaskDefinitions({
      [ManifestTaskConstants.TYPE]: {
        title: 'Security Solution Endpoint Exceptions Handler',
        timeout: packagerTaskTimeout,
        createTaskRunner: ({ taskInstance }: { taskInstance: ConcreteTaskInstance }) => {
          return {
            run: async () => {
              const taskInterval = packagerTaskInterval;
              const startTime = new Date();

              this.logger.info(`Started. Checking for changes to endpoint artifacts`);

              await this.runTask(taskInstance.id);

              const endTime = new Date().getTime();

              this.logger.info(
                `Complete. Task run took ${
                  endTime - startTime.getTime()
                }ms [ stated: ${startTime.toISOString()} ]`
              );

              const nextRun = new Date();

              if (taskInterval.endsWith('s')) {
                const seconds = parseInt(taskInterval.slice(0, -1), 10);
                nextRun.setSeconds(nextRun.getSeconds() + seconds);
              } else if (taskInterval.endsWith('m')) {
                const minutes = parseInt(taskInterval.slice(0, -1), 10);
                nextRun.setMinutes(nextRun.getMinutes() + minutes);
              } else {
                this.logger.error(`Invalid task interval: ${taskInterval}`);
                return;
              }

              return {
                state: {},
                runAt: nextRun,
              };
            },
            cancel: async () => {
              // TODO:PT add support for AbortController to Task manager
              this.logger.warn(
                'Task run was canceled. Packaging of endpoint artifacts may be taking longer due to the ' +
                  'amount of policies/artifacts. Consider increasing the `xpack.securitySolution.packagerTaskTimeout` ' +
                  'server configuration setting if this continues'
              );
            },
          };
        },
      },
    });
  }

  public start = async (startContract: ManifestTaskStartContract) => {
    this.wasStarted = true;

    try {
      await startContract.taskManager.ensureScheduled({
        id: this.getTaskId(),
        taskType: ManifestTaskConstants.TYPE,
        scope: ['securitySolution'],
        schedule: {
          interval: this.endpointAppContext.serverConfig.packagerTaskInterval,
        },
        state: {},
        params: { version: ManifestTaskConstants.VERSION },
      });
    } catch (e) {
      this.logger.error(new EndpointError(`Error scheduling task, received ${e.message}`, e));
    }
  };

  private getTaskId = (): string => {
    return `${ManifestTaskConstants.TYPE}:${ManifestTaskConstants.VERSION}`;
  };

  public runTask = async (taskId: string) => {
    // if task was not `.start()`'d yet, then exit
    if (!this.wasStarted) {
      this.logger.debug('[runTask()] Aborted. ManifestTask not started yet');
      return;
    }

    // Check that this task is current
    if (taskId !== this.getTaskId()) {
      // old task, return
      this.logger.debug(`Outdated task running: ${taskId}`);
      return;
    }

    console.time('🧀 getManifestManager ⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️');

    const manifestManager = this.endpointAppContext.service.getManifestManager();

    if (manifestManager === undefined) {
      this.logger.error('Manifest Manager not available.');
      return;
    }

    console.timeEnd('🧀 getManifestManager ⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️⬇️');

    try {
      let oldManifest: Manifest | null = null;

      try {
        // Last manifest we computed, which was saved to ES
        console.time('🧀 getLastComputedManifest');
        oldManifest = await manifestManager.getLastComputedManifest();
        console.timeEnd('🧀 getLastComputedManifest');
      } catch (e) {
        this.logger.error(e);

        // Lets recover from a failure in getting the internal manifest map by creating an empty default manifest
        if (e instanceof InvalidInternalManifestError) {
          this.logger.warn('recovering from invalid internal manifest');
          oldManifest = ManifestManager.createDefaultManifest();
        } else {
          this.logger.error(
            `unable to recover from error while attempting to retrieve last computed manifest`
          );

          return;
        }
      }

      if (!oldManifest) {
        this.logger.info('Last computed manifest not available yet');
        return;
      }

      // New computed manifest based on current manifest
      console.time('🧀 buildNewManifest');
      const newManifest = await manifestManager.buildNewManifest(oldManifest);
      console.timeEnd('🧀 buildNewManifest');

      console.time('🧀 diff');
      const diff = newManifest.diff(oldManifest);
      console.timeEnd('🧀 diff');

      this.logger.debug(
        `New -vs- old manifest diff counts: ${Object.entries(diff).map(
          ([diffType, diffItems]) => `${diffType}: ${diffItems.length}`
        )}`
      );

      console.time('🧀 pushArtifacts');
      const persistErrors = await manifestManager.pushArtifacts(
        diff.additions as InternalArtifactCompleteSchema[],
        newManifest
      );
      console.timeEnd('🧀 pushArtifacts');

      if (persistErrors.length) {
        reportErrors(this.logger, persistErrors);
        throw new Error('Unable to persist new artifacts.');
      }

      console.time('🧀 bumpSemanticVersion & commit OUTER');
      if (!isEmptyManifestDiff(diff)) {
        console.time('🧀 bumpSemanticVersion & commit INNER');
        // Commit latest manifest state
        newManifest.bumpSemanticVersion();
        await manifestManager.commit(newManifest);
        console.timeEnd('🧀 bumpSemanticVersion & commit INNER');
      }
      console.timeEnd('🧀 bumpSemanticVersion & commit OUTER');

      // Dispatch updates to Fleet integration policies with new manifest info
      console.time('🧀 tryDispatch');
      const dispatchErrors = await manifestManager.tryDispatch(newManifest);
      console.timeEnd('🧀 tryDispatch');

      if (dispatchErrors.length) {
        reportErrors(this.logger, dispatchErrors);
        throw new Error('Error dispatching manifest.');
      }

      // Try to clean up superceded artifacts
      console.time('🧀 deleteArtifacts');
      const deleteErrors = await manifestManager.deleteArtifacts(
        diff.removals.map((artifact) => getArtifactId(artifact))
      );
      console.timeEnd('🧀 deleteArtifacts');

      if (deleteErrors.length) {
        reportErrors(this.logger, deleteErrors);
      }

      console.time('🧀 cleanup ⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️');
      await manifestManager.cleanup(newManifest);
      console.timeEnd('🧀 cleanup ⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️⬆️');
    } catch (err) {
      this.logger.error(wrapErrorIfNeeded(err));
    }
  };
}
