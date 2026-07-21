"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
import type { Folder, Video } from "@cap/web-domain";
import { faFolder, faFolderOpen } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { getAllUserFolders } from "@/actions/folders/get-all-folders";
import { moveVideoToFolder } from "@/actions/folders/moveVideoToFolder";

type FolderOption = {
	id: Folder.FolderId;
	name: string;
	color: "normal" | "blue" | "red" | "yellow" | null;
	parentId: Folder.FolderId | null;
	context: "meeting" | "instruction" | null;
};

interface MoveToFolderDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	selectedCaps: Video.VideoId[];
	onComplete: () => void;
	currentFolderId?: Folder.FolderId | null;
}

export function MoveToFolderDialog({
	open,
	onOpenChange,
	selectedCaps,
	onComplete,
	currentFolderId,
}: MoveToFolderDialogProps) {
	const router = useRouter();
	const [folders, setFolders] = useState<FolderOption[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [selectedFolderId, setSelectedFolderId] =
		useState<Folder.FolderId | null>(null);
	const [isMoving, startMoving] = useTransition();

	useEffect(() => {
		if (!open) {
			setSelectedFolderId(null);
			return;
		}

		setIsLoading(true);
		getAllUserFolders()
			.then((data) => setFolders(data as FolderOption[]))
			.catch(() => toast.error("Failed to load folders"))
			.finally(() => setIsLoading(false));
	}, [open]);

	const availableFolders = folders.filter((f) => f.id !== currentFolderId);

	const handleMove = () => {
		if (!selectedFolderId || selectedCaps.length === 0) return;

		startMoving(async () => {
			try {
				await Promise.all(
					selectedCaps.map((videoId) =>
						moveVideoToFolder({ videoId, folderId: selectedFolderId }),
					),
				);

				const folder = folders.find((f) => f.id === selectedFolderId);
				toast.success(
					`Moved ${selectedCaps.length} cap${selectedCaps.length === 1 ? "" : "s"} to "${folder?.name}"`,
				);
				onOpenChange(false);
				onComplete();
				router.refresh();
			} catch {
				toast.error("Failed to move caps");
			}
		});
	};

	const folderColorMap: Record<string, string> = {
		normal: "text-gray-9",
		blue: "text-blue-9",
		red: "text-red-9",
		yellow: "text-yellow-9",
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[calc(100%-20px)] max-w-md">
				<DialogHeader
					icon={
						<FontAwesomeIcon icon={faFolderOpen} className="size-3.5" />
					}
				>
					<DialogTitle>Move to folder</DialogTitle>
				</DialogHeader>
				<div className="p-5">
					{isLoading ? (
						<p className="text-sm text-gray-10">Loading folders...</p>
					) : availableFolders.length === 0 ? (
						<p className="text-sm text-gray-10">
							No folders available. Create a folder first.
						</p>
					) : (
						<div className="flex flex-col gap-1 max-h-[300px] overflow-y-auto">
							{availableFolders.map((folder) => (
								<button
									key={folder.id}
									type="button"
									onClick={() => setSelectedFolderId(folder.id)}
									className={clsx(
										"flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors",
										selectedFolderId === folder.id
											? "bg-blue-3 border border-blue-7"
											: "hover:bg-gray-3 border border-transparent",
									)}
								>
									<FontAwesomeIcon
										icon={faFolder}
										className={clsx(
											"size-4",
											folderColorMap[folder.color ?? "normal"] ?? "text-gray-9",
										)}
									/>
									<div className="flex flex-col min-w-0">
										<span className="text-sm font-medium text-gray-12 truncate">
											{folder.name}
										</span>
										{folder.context && (
											<span className="text-xs text-gray-9">
												{folder.context === "meeting"
													? "Meeting"
													: "Instructional"}
											</span>
										)}
									</div>
								</button>
							))}
						</div>
					)}
				</div>
				<DialogFooter>
					<Button
						size="sm"
						variant="gray"
						onClick={() => onOpenChange(false)}
						disabled={isMoving}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						variant="dark"
						onClick={handleMove}
						disabled={!selectedFolderId || isMoving}
						spinner={isMoving}
					>
						{isMoving
							? "Moving..."
							: `Move ${selectedCaps.length} cap${selectedCaps.length !== 1 ? "s" : ""}`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
