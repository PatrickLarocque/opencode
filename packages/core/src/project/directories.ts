export * as ProjectDirectories from "./directories"

import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { LayerNode } from "../effect/layer-node"
import { AbsolutePath, optionalOmitUndefined } from "../schema"
import { ProjectSchema } from "./schema"
import { ProjectDirectoryTable } from "./sql"

export interface Directory {
  readonly directory: AbsolutePath
  readonly strategy?: string
}

export const ListInput = Schema.Struct({
  projectID: ProjectSchema.ID,
}).annotate({ identifier: "Project.DirectoriesInput" })
export type ListInput = typeof ListInput.Type

export const ListOutput = Schema.Array(
  Schema.Struct({
    directory: AbsolutePath,
    strategy: optionalOmitUndefined(Schema.String),
  }),
).annotate({ identifier: "Project.Directories" })
export type ListOutput = typeof ListOutput.Type

export interface Interface {
  readonly list: (projectID: ProjectSchema.ID) => Effect.Effect<ReadonlyArray<Directory>>
  readonly get: (input: {
    projectID: ProjectSchema.ID
    directory: AbsolutePath
  }) => Effect.Effect<Directory | undefined>
  readonly contains: (input: { projectID: ProjectSchema.ID; directory: AbsolutePath }) => Effect.Effect<boolean>
  readonly register: (input: {
    projectID: ProjectSchema.ID
    directory: AbsolutePath
    strategy?: string
  }) => Effect.Effect<boolean>
  readonly classify: (input: {
    projectID: ProjectSchema.ID
    directory: AbsolutePath
    strategy: string
  }) => Effect.Effect<boolean>
  readonly remove: (input: { projectID: ProjectSchema.ID; directory: AbsolutePath }) => Effect.Effect<boolean>
  readonly update: (input: {
    projectID: ProjectSchema.ID
    add?: ReadonlyArray<Directory>
    remove?: ReadonlyArray<AbsolutePath>
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectDirectories") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const list = Effect.fn("ProjectDirectories.list")(function* (projectID: ProjectSchema.ID) {
      const rows = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, projectID))
        .orderBy(desc(ProjectDirectoryTable.time_created), asc(ProjectDirectoryTable.directory))
        .all()
        .pipe(Effect.orDie)
      return rows.map((row) => ({ directory: row.directory, strategy: row.strategy ?? undefined }))
    })

    const contains = Effect.fn("ProjectDirectories.contains")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      return (
        (yield* db
          .select({ directory: ProjectDirectoryTable.directory })
          .from(ProjectDirectoryTable)
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, input.directory),
            ),
          )
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const get = Effect.fn("ProjectDirectories.get")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      const row = yield* db
        .select({ directory: ProjectDirectoryTable.directory, strategy: ProjectDirectoryTable.strategy })
        .from(ProjectDirectoryTable)
        .where(
          and(
            eq(ProjectDirectoryTable.project_id, input.projectID),
            eq(ProjectDirectoryTable.directory, input.directory),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      return row ? { directory: row.directory, strategy: row.strategy ?? undefined } : undefined
    })

    const update = Effect.fn("ProjectDirectories.update")(function* (input: {
      projectID: ProjectSchema.ID
      add?: ReadonlyArray<Directory>
      remove?: ReadonlyArray<AbsolutePath>
    }) {
      const changed = yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const added = yield* Effect.forEach(input.add ?? [], (item) =>
                tx
                  .insert(ProjectDirectoryTable)
                  .values({ project_id: input.projectID, directory: item.directory, strategy: item.strategy })
                  .onConflictDoNothing()
                  .returning({ directory: ProjectDirectoryTable.directory })
                  .get(),
              )
              const removed = input.remove?.length
                ? yield* tx
                    .delete(ProjectDirectoryTable)
                    .where(
                      and(
                        eq(ProjectDirectoryTable.project_id, input.projectID),
                        inArray(ProjectDirectoryTable.directory, input.remove),
                      ),
                    )
                    .returning({ directory: ProjectDirectoryTable.directory })
                    .all()
                : []
              return added.some((item) => item !== undefined) || removed.length > 0
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
      return changed
    })

    const register = Effect.fn("ProjectDirectories.register")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
      strategy?: string
    }) {
      return yield* update({
        projectID: input.projectID,
        add: [{ directory: input.directory, strategy: input.strategy }],
      })
    })

    const classify = Effect.fn("ProjectDirectories.classify")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
      strategy: string
    }) {
      return (
        (yield* db
          .update(ProjectDirectoryTable)
          .set({ strategy: input.strategy })
          .where(
            and(
              eq(ProjectDirectoryTable.project_id, input.projectID),
              eq(ProjectDirectoryTable.directory, input.directory),
              or(isNull(ProjectDirectoryTable.strategy), ne(ProjectDirectoryTable.strategy, input.strategy)),
            ),
          )
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const remove = Effect.fn("ProjectDirectories.remove")(function* (input: {
      projectID: ProjectSchema.ID
      directory: AbsolutePath
    }) {
      return yield* update({ projectID: input.projectID, remove: [input.directory] })
    })

    return Service.of({ list, get, contains, register, classify, remove, update })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))
export const node = LayerNode.make(layer, [Database.node])
