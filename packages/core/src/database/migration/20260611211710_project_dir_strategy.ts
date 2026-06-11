import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260611211710_project_dir_strategy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`project_directory\` ADD \`strategy\` text;`)
      yield* tx.run(`ALTER TABLE \`project_directory\` DROP COLUMN \`type\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
