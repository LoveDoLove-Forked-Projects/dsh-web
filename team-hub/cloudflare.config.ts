import { bindings, defineConfig, exports, triggers } from "cf/config";

/**
 * Deployment configuration for the team hub Worker.
 *
 * The Durable Object namespace is declared twice on purpose: `exports` owns the
 * class lifecycle (the first deploy provisions the namespace, later deploys
 * compare it with the class the Worker actually exports), while `env.TEAM_CHANNEL`
 * is the binding user code reaches it through. Both name the same class.
 */
export default defineConfig({
	worker: {
		name: "dsh-team-hub",
		compatibilityDate: "2026-08-01",
		compatibilityFlags: [
			"nodejs_compat",
		],
		entrypoint: "src/index.ts",
		observability: {
			enabled: true,
			headSamplingRate: 1,
		},
		triggers: [
			triggers.scheduled({
				schedule: "* * * * *",
			}),
		],
		exports: {
			TeamChannelDO: exports.durableObject({
				storage: "sqlite",
			}),
		},
		env: {
			DB: bindings.d1({
				name: "dsh-team-hub",
				id: "REPLACE_WITH_D1_DATABASE_ID",
			}),
			TEAM_CHANNEL: bindings.durableObject({
				worker: "dsh-team-hub",
				exportName: "TeamChannelDO",
			}),
		},
	},
});
