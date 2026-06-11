export * as ProjectCopy from "./copy"

import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { AbsolutePath } from "../schema"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { LayerNode } from "../effect/layer-node"
import { Project } from "../project"
import { ProjectDirectories } from "./directories"
import { makeGitWorktreeStrategy } from "./copy-strategies"
import { Slug } from "../util/slug"
import { EventV2 } from "../event"
import { Location } from "../location"
import { PluginBoot } from "../plugin/boot"

export const StrategyID = Schema.Trim.pipe(Schema.check(Schema.isNonEmpty()), Schema.brand("ProjectCopy.StrategyID"))
export type StrategyID = typeof StrategyID.Type

export const DetectInput = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "ProjectCopy.DetectInput" })
export type DetectInput = typeof DetectInput.Type

export const CreateInput = Schema.Struct({
  projectID: Project.ID,
  strategy: StrategyID,
  sourceDirectory: AbsolutePath,
  directory: AbsolutePath,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "ProjectCopy.CreateInput" })
export type CreateInput = typeof CreateInput.Type

export const RemoveInput = Schema.Struct({
  projectID: Project.ID,
  directory: AbsolutePath,
  force: Schema.Boolean,
}).annotate({ identifier: "ProjectCopy.RemoveInput" })
export type RemoveInput = typeof RemoveInput.Type

export const RefreshInput = Schema.Struct({
  projectID: Project.ID,
}).annotate({ identifier: "ProjectCopy.RefreshInput" })
export type RefreshInput = typeof RefreshInput.Type

export const Copy = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "ProjectCopy.Copy" })
export type Copy = typeof Copy.Type

export class SourceDirectoryNotFoundError extends Schema.TaggedErrorClass<SourceDirectoryNotFoundError>()(
  "ProjectCopy.SourceDirectoryNotFoundError",
  { directory: AbsolutePath },
) {}

export class DestinationExistsError extends Schema.TaggedErrorClass<DestinationExistsError>()(
  "ProjectCopy.DestinationExistsError",
  { directory: AbsolutePath },
) {}

export class DirectoryUnavailableError extends Schema.TaggedErrorClass<DirectoryUnavailableError>()(
  "ProjectCopy.DirectoryUnavailableError",
  { directory: AbsolutePath },
) {}

export class StrategyNotFoundError extends Schema.TaggedErrorClass<StrategyNotFoundError>()(
  "ProjectCopy.StrategyNotFoundError",
  { directory: AbsolutePath },
) {}

export class StrategyUnavailableError extends Schema.TaggedErrorClass<StrategyUnavailableError>()(
  "ProjectCopy.StrategyUnavailableError",
  { strategy: StrategyID },
) {}

export class DuplicateStrategyError extends Schema.TaggedErrorClass<DuplicateStrategyError>()(
  "ProjectCopy.DuplicateStrategyError",
  { strategy: StrategyID },
) {}

export type Error =
  | SourceDirectoryNotFoundError
  | DestinationExistsError
  | DirectoryUnavailableError
  | StrategyNotFoundError
  | StrategyUnavailableError
  | Git.WorktreeError

export interface Strategy {
  readonly id: StrategyID
  readonly create: (input: {
    sourceDirectory: AbsolutePath
    directory: AbsolutePath
  }) => Effect.Effect<Copy, Git.WorktreeError | DirectoryUnavailableError>
  readonly remove: (input: {
    directory: AbsolutePath
    force: boolean
  }) => Effect.Effect<void, Git.WorktreeError | DirectoryUnavailableError>
  readonly list: (directory: AbsolutePath) => Effect.Effect<Copy[], Git.WorktreeError | DirectoryUnavailableError>
  readonly detect: (directory: AbsolutePath) => Effect.Effect<boolean>
}

export const Event = {
  Updated: EventV2.define({
    type: "project.directories.updated",
    schema: { projectID: Project.ID },
  }),
}

export interface Interface {
  readonly register: (strategy: Strategy) => Effect.Effect<void, DuplicateStrategyError>
  readonly detect: (input: DetectInput) => Effect.Effect<StrategyID | undefined>
  readonly create: (input: CreateInput) => Effect.Effect<Copy, Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<void, Error>
  readonly refresh: (input: RefreshInput) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectCopy") {}

export const refreshAfterBoot = Effect.gen(function* () {
  const location = yield* Location.Service
  const boot = yield* PluginBoot.Service
  const copies = yield* Service
  yield* Effect.gen(function* () {
    yield* boot.wait()
    yield* copies.refresh({ projectID: location.project.id })
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("project copy refresh failed", { cause })),
    Effect.forkScoped,
    Effect.asVoid,
  )
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const directories = yield* ProjectDirectories.Service
    const events = yield* EventV2.Service

    const changed = Effect.fnUntraced(function* (projectID: Project.ID, update: boolean) {
      if (update) yield* events.publish(Event.Updated, { projectID })
    })

    const canonical = Effect.fnUntraced(function* (input: AbsolutePath) {
      const resolved = AbsolutePath.make(FSUtil.resolve(input))
      if (!(yield* fs.isDir(resolved))) return yield* new DirectoryUnavailableError({ directory: input })
      return resolved
    })

    const registry = new Map<StrategyID, Strategy>()

    const register = Effect.fn("ProjectCopy.register")(function* (strategy: Strategy) {
      if (registry.has(strategy.id)) return yield* new DuplicateStrategyError({ strategy: strategy.id })
      registry.set(strategy.id, strategy)
    })

    // Register default strategies
    yield* register(makeGitWorktreeStrategy({ git, fs, canonical })).pipe(Effect.orDie)

    const strategies = () => Array.from(registry.values())

    const source = Effect.fnUntraced(function* (input: AbsolutePath, projectID: Project.ID) {
      const sourceDirectory = yield* canonical(input)
      if (!(yield* directories.contains({ projectID, directory: sourceDirectory })))
        return yield* new SourceDirectoryNotFoundError({ directory: sourceDirectory })
      return sourceDirectory
    })

    const getStrategy = Effect.fnUntraced(function* (id: StrategyID) {
      const found = registry.get(id)
      if (!found) return yield* new StrategyUnavailableError({ strategy: id })
      return found
    })

    const detect = Effect.fn("ProjectCopy.detect")(function* (input: DetectInput) {
      for (const strategy of strategies()) {
        if (yield* strategy.detect(input.directory)) return strategy.id
      }
      return undefined
    })

    const create = Effect.fn("ProjectCopy.create")(function* (input: CreateInput) {
      const selected = yield* getStrategy(input.strategy)
      const sourceDirectory = yield* source(input.sourceDirectory, input.projectID)
      yield* fs.makeDirectory(input.directory, { recursive: true }).pipe(Effect.orDie)
      const name = input.name ?? Slug.create()
      let suffix = 1
      let copyDirectory = AbsolutePath.make(path.join(input.directory, name))
      while (yield* fs.existsSafe(copyDirectory)) {
        suffix++
        if (suffix > 10) return yield* new DestinationExistsError({ directory: copyDirectory })
        copyDirectory = AbsolutePath.make(path.join(input.directory, `${name}-${suffix}`))
      }

      const result = yield* selected.create({
        directory: copyDirectory,
        sourceDirectory,
      })
      yield* changed(
        input.projectID,
        yield* directories.register({
          projectID: input.projectID,
          directory: result.directory,
          strategy: input.strategy,
        }),
      )
      return result
    })

    const remove = Effect.fn("ProjectCopy.remove")(function* (input: RemoveInput) {
      const copyDirectory = yield* canonical(input.directory)
      const stored = yield* directories.get({ projectID: input.projectID, directory: copyDirectory })
      if (!stored?.strategy) return yield* new StrategyNotFoundError({ directory: copyDirectory })
      yield* (yield* getStrategy(StrategyID.make(stored.strategy))).remove({
        directory: copyDirectory,
        force: input.force,
      })
      yield* changed(input.projectID, yield* directories.remove({ projectID: input.projectID, directory: copyDirectory }))
    })

    const refresh = Effect.fn("ProjectCopy.refresh")(function* (input: RefreshInput) {
      const stored = yield* directories.list(input.projectID)
      const roots = stored.filter((item) => item.strategy === undefined)
      const sourceDirectories = yield* Effect.forEach(
        roots,
        (item) => fs.isDir(item.directory).pipe(Effect.map((exists) => (exists ? item.directory : undefined))),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items) => items.filter((item): item is AbsolutePath => item !== undefined)))
      const discovered = yield* Effect.forEach(
        sourceDirectories,
        (sourceDirectory) =>
          Effect.forEach(strategies(), (strategy) =>
            strategy
              .list(sourceDirectory)
              .pipe(Effect.map((items) => items.map((item) => ({ ...item, strategy: strategy.id })))),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((sets) => new Map(sets.flat(2).map((item) => [item.directory, item] as const)).values().toArray()),
      )
      const classified = yield* Effect.forEach(discovered, (item) =>
        directories.register({ projectID: input.projectID, directory: item.directory }).pipe(
          Effect.andThen(
            directories.classify({
              projectID: input.projectID,
              directory: item.directory,
              strategy: item.strategy,
            }),
          ),
        ),
      ).pipe(Effect.map((items) => items.some(Boolean)))
      const removed = yield* Effect.forEach(
        stored.filter((item) => item.strategy !== undefined),
        (item) => fs.isDir(item.directory).pipe(Effect.map((exists) => (exists ? undefined : item.directory))),
      ).pipe(Effect.map((items) => items.filter((item): item is AbsolutePath => item !== undefined)))
      yield* changed(input.projectID, (yield* directories.update({ projectID: input.projectID, remove: removed })) || classified)
    })

    return Service.of({
      register,
      detect,
      create,
      remove,
      refresh,
    })
  }),
)

export const locationLayer = layer
export const node = LayerNode.make(layer, [FSUtil.node, Git.node, ProjectDirectories.node, EventV2.node])
