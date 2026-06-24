import type { Metadata } from "next";
import { ImportLoomPage } from "./ImportLoomPage";

export const metadata: Metadata = {
	title: "Import from Loom — data365",
};

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ context?: string }>;
}) {
	const { context: rawContext } = await searchParams;
	const context: "meeting" | "instruction" =
		rawContext === "meeting" ? "meeting" : "instruction";
	return <ImportLoomPage context={context} />;
}
