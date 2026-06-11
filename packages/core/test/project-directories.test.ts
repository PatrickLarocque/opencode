import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectDirectories } from "@opencode-ai/core/project/directories"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = EventV2.layer.pipe(Layer.provide(database))
const directories = ProjectDirectories.layer.pipe(Layer.provide(database), Layer.provide(events))
const it = testEffect(Layer.mergeAll(database, events, directories))

const projectID = Project.ID.make("project-directories")
const directory = AbsolutePath.make("/tmp/project-directories")

function setup() {
  return Database.Service.use(({ db }) =>
    db
      .insert(ProjectTable)
      .values({ id: projectID, worktree: directory, sandboxes: [], time_created: 1, time_updated: 1 })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )
}

describe("ProjectDirectories", () => {
  it.effect("decodes directory schemas", () =>
    Effect.sync(() => {
      expect(Schema.decodeUnknownSync(ProjectDirectories.ListInput)({ projectID })).toEqual({ projectID })
      expect(Schema.decodeUnknownSync(ProjectDirectories.ListOutput)([{ directory }])).toEqual([{ directory }])
    }),
  )

  it.effect("registers once without replacing the existing row", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service

      expect(yield* service.register({ projectID, directory })).toBe(true)
      expect(yield* service.register({ projectID, directory, strategy: "git_worktree" })).toBe(false)
      expect(yield* service.list(projectID)).toEqual([{ directory, strategy: undefined }])
    }),
  )

  it.effect("batches additions and removals into one update", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service
      const copy = AbsolutePath.make("/tmp/project-directories-copy")
      yield* service.register({ projectID, directory })

      expect(
        yield* service.update({
          projectID,
          add: [{ directory: copy, strategy: "git_worktree" }],
          remove: [directory],
        }),
      ).toBe(true)
      expect(yield* service.list(projectID)).toEqual([{ directory: copy, strategy: "git_worktree" }])
    }),
  )

  it.effect("updates a stale strategy only after positive classification", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* ProjectDirectories.Service
      yield* service.register({ projectID, directory, strategy: "old/strategy" })

      expect(yield* service.classify({ projectID, directory, strategy: "new/strategy" })).toBe(true)
      expect(yield* service.classify({ projectID, directory, strategy: "new/strategy" })).toBe(false)
      expect(yield* service.list(projectID)).toEqual([{ directory, strategy: "new/strategy" }])
    }),
  )
})
