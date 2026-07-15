import type {
  SchedulerDispatchBatch,
  SchedulerDispatchResult,
  SchedulerProducerKind,
  SchedulerSettlement,
} from "./conversation-scheduler.js";

export type SchedulerProducerRegistration = {
  producerKinds: readonly SchedulerProducerKind[];
  dispatch(batch: SchedulerDispatchBatch): Promise<SchedulerDispatchResult>;
  settle?(settlement: SchedulerSettlement): Promise<void>;
};

export type SchedulerProducerRegistry = {
  register(registration: SchedulerProducerRegistration): () => void;
  owns(producerKind: SchedulerProducerKind): boolean;
  dispatch(batch: SchedulerDispatchBatch): Promise<SchedulerDispatchResult>;
  settle(settlement: SchedulerSettlement): Promise<void>;
};

/**
 * Owns the one-to-one mapping from durable producer kinds to their runtime
 * dispatch implementation. Registration wakes rows admitted before startup.
 */
export function createSchedulerProducerRegistry(options?: {
  onProducerAvailable?: () => void;
}): SchedulerProducerRegistry {
  const registrations = new Map<SchedulerProducerKind, SchedulerProducerRegistration>();

  return {
    register(registration) {
      const producerKinds = [...new Set(registration.producerKinds)];
      if (producerKinds.length === 0) {
        throw new Error("scheduler producer registration requires at least one producer kind");
      }
      for (const producerKind of producerKinds) {
        if (registrations.has(producerKind)) {
          throw new Error(`scheduler producer ${producerKind} is already registered`);
        }
      }
      for (const producerKind of producerKinds) {
        registrations.set(producerKind, registration);
      }
      options?.onProducerAvailable?.();
      let registered = true;
      return () => {
        if (!registered) {
          return;
        }
        registered = false;
        for (const producerKind of producerKinds) {
          if (registrations.get(producerKind) === registration) {
            registrations.delete(producerKind);
          }
        }
      };
    },

    owns(producerKind) {
      return registrations.has(producerKind);
    },

    async dispatch(batch) {
      const first = batch.events[0];
      if (!first) {
        throw new Error("scheduler cannot dispatch an empty producer batch");
      }
      const registration = registrations.get(first.producerKind);
      if (!registration) {
        throw new Error(`scheduler producer ${first.producerKind} is not registered`);
      }
      if (batch.events.some((event) => registrations.get(event.producerKind) !== registration)) {
        throw new Error("scheduler batch crossed producer ownership");
      }
      return await registration.dispatch(batch);
    },

    async settle(settlement) {
      const registration = registrations.get(settlement.event.producerKind);
      if (!registration) {
        throw new Error(
          `scheduler producer ${settlement.event.producerKind} is not registered for settlement`,
        );
      }
      await registration?.settle?.(settlement);
    },
  };
}
