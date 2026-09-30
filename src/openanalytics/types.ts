/** The stable fields needed from GET /v1/read/site; additive fields are ignored. */
export interface SiteReadContext {
	readonly site_id: string;
	readonly slug: string;
	readonly name: string;
	readonly status: "active" | "suspended" | "deleting" | "deleted";
	readonly install: {
		readonly tracking_key: string | null;
		readonly script_url: string | null;
		readonly collector_url: string | null;
	};
}
