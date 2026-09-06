import { Cause, Context, Effect, Exit, Fiber, Option, Supervisor } from "effect";

/** Observe Layer workers as well as operation children, including suspended work. */
export class DriverSupervisor extends Supervisor.AbstractSupervisor<number> {
  private readonly roots = new Set<number>();
  private readonly active = new Map<number, boolean>();
  private readonly failures: Cause.Cause<unknown>[] = [];
  private readonly children: Cause.Cause<unknown>[] = [];

  override value: Effect.Effect<number> = Effect.sync(() => this.active.size);

  registerRoot<A, E>(fiber: Fiber.RuntimeFiber<A, E>): void {
    this.roots.add(fiber.id().id);
    if (this.active.has(fiber.id().id)) this.active.set(fiber.id().id, true);
  }

  forgetRoot<A, E>(fiber: Fiber.RuntimeFiber<A, E>): void {
    this.roots.delete(fiber.id().id);
  }

  pending(): number { return this.active.size; }
  backgroundFailures(): readonly Cause.Cause<unknown>[] { return [...this.failures]; }
  childFailures(): readonly Cause.Cause<unknown>[] { return [...this.children]; }
  backgroundFailureCount(): number { return this.failures.filter(cause => !Cause.isInterruptedOnly(cause)).length; }

  override onStart<A, E, R>(
    _context: Context.Context<R>, _effect: Effect.Effect<A, E, R>,
    parent: Parameters<Supervisor.Supervisor<number>["onStart"]>[2], fiber: Fiber.RuntimeFiber<A, E>,
  ): void {
    const parentId = Option.isSome(parent) ? parent.value.id().id : undefined;
    const operationOwned = this.roots.has(fiber.id().id) || (parentId !== undefined
      && (this.roots.has(parentId) || this.active.get(parentId) === true));
    this.active.set(fiber.id().id, operationOwned);
  }

  override onEnd<A, E>(exit: Exit.Exit<A, E>, fiber: Fiber.RuntimeFiber<A, E>): void {
    if (Exit.isFailure(exit) && !this.roots.has(fiber.id().id)) {
      if (this.active.get(fiber.id().id) === false) this.failures.push(exit.cause);
      else if (this.active.get(fiber.id().id) === true) this.children.push(exit.cause);
    }
    this.active.delete(fiber.id().id);
  }
}
