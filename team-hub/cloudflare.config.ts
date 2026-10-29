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
		// A workers.dev hostname is not reachable from every network this team
		// works from, so the hub answers on a subdomain of a zone this account
		// already serves.
		// The dsh-market.com zone answers *.dsh-market.com (any depth) from the
		// market Worker, so no hostname on it can reach this one; the hub is served
		// on its workers.dev hostname instead.
		workersDev: true,
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
				id: "add4f9cc-163a-4eac-90d7-91663d1b6d10",
			}),
			TEAM_CHANNEL: bindings.durableObject({
				worker: "dsh-team-hub",
				exportName: "TeamChannelDO",
			}),
		},
	},
});
