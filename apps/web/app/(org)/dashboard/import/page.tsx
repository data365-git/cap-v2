import type { Metadata } from "next";
import { ImportPage } from "./ImportPage";

export const metadata: Metadata = {
	title: "Import — data365",
};

export default async function Page({
	searchParams,
}: {
	searchParams: Promise<{ folderId?: string; context?: string }>;
}) {
	const { folderId, context: rawContext } = await searchParams;
	const context: "meeting" | "instruction" =
		rawContext === "meeting" ? "meeting" : "instruction";
	return <ImportPage folderId={folderId} context={context} />;
}
