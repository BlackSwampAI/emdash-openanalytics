import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = ({ request }) => {
	const expected = process.env.EMDASH_DEMO_RUN_ID;
	const supplied = new URL(request.url).searchParams.get("run");
	if (!expected || supplied !== expected) return new Response("Not found", { status: 404 });
	return new Response(JSON.stringify({ run: expected }), {
		headers: { "Content-Type": "application/json" },
	});
};
