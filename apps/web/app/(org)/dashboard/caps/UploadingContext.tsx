"use client";

import { useStore } from "@tanstack/react-store";
import { Store } from "@tanstack/store";
import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { cancelUpload } from "@/actions/video/cancel-upload";

export type UploadStatus =
	| {
			status: "parsing";
	  }
	| {
			status: "creating";
	  }
	| {
			status: "converting";
			capId: string;
			progress: number;
	  }
	| {
			status: "uploadingThumbnail";
			capId: string;
			progress: number;
	  }
	| {
			status: "uploadingVideo";
			capId: string;
			progress: number;
			thumbnailUrl: string | undefined;
	  }
	| {
			status: "serverProcessing";
			capId: string;
	  }
	| {
			status: "processing";
			capId: string;
			startedAt: number;
	  };

interface UploadingStoreState {
	uploadStatus?: UploadStatus;
	abortController: AbortController | null;
}

interface UploadingContextType {
	uploadingStore: Store<UploadingStoreState>;
	setUploadStatus: (state: UploadStatus | undefined) => void;
	setAbortController: (c: AbortController | null) => void;
	cancelCurrent: () => void;
	dismissProcessing: () => void;
}

const UploadingContext = createContext<UploadingContextType | undefined>(
	undefined,
);

export function useUploadingContext() {
	const context = useContext(UploadingContext);
	if (!context)
		throw new Error(
			"useUploadingContext must be used within an UploadingProvider",
		);
	return context;
}

export function useUploadingStatus() {
	const { uploadingStore } = useUploadingContext();
	return useStore(
		uploadingStore,
		(s) =>
			[
				s.uploadStatus !== undefined,
				s.uploadStatus && "capId" in s.uploadStatus
					? s.uploadStatus.capId
					: null,
			] as const,
	);
}

export function UploadingProvider({ children }: { children: React.ReactNode }) {
	const [uploadingStore] = useState<Store<UploadingStoreState>>(
		() => new Store<UploadingStoreState>({ abortController: null }),
	);

	const setUploadStatus = (status: UploadStatus | undefined) => {
		uploadingStore.setState((state) => ({
			...state,
			uploadStatus: status,
		}));
	};

	const setAbortController = (c: AbortController | null) => {
		uploadingStore.setState((state) => ({
			...state,
			abortController: c,
		}));
	};

	const cancelCurrent = () => {
		const { abortController, uploadStatus } = uploadingStore.state;
		abortController?.abort();
		if (uploadStatus && "capId" in uploadStatus) {
			cancelUpload({ videoId: uploadStatus.capId }).catch(() => {});
		}
		uploadingStore.setState((state) => ({
			...state,
			uploadStatus: undefined,
			abortController: null,
		}));
	};

	const dismissProcessing = () => {
		const { uploadStatus } = uploadingStore.state;
		if (uploadStatus?.status === "processing") {
			uploadingStore.setState((state) => ({
				...state,
				uploadStatus: undefined,
			}));
		}
	};

	return (
		<UploadingContext.Provider
			value={{
				uploadingStore,
				setUploadStatus,
				setAbortController,
				cancelCurrent,
				dismissProcessing,
			}}
		>
			{children}

			<ForbidLeaveWhenUploading />
			<GlobalUploadProgressBarLazy />
		</UploadingContext.Provider>
	);
}

// Separated to prevent rerendering whole tree
function ForbidLeaveWhenUploading() {
	const { uploadingStore } = useUploadingContext();
	const uploadStatus = useStore(uploadingStore, (state) => state.uploadStatus);

	useEffect(() => {
		const handleBeforeUnload = (e: BeforeUnloadEvent) => {
			if (uploadStatus?.status) {
				e.preventDefault();
				// Chrome requires returnValue to be set
				e.returnValue = "";
				return "";
			}
		};

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [uploadStatus]);

	return null;
}

// Lazy-load the progress bar to avoid circular imports
function GlobalUploadProgressBarLazy() {
	const [Bar, setBar] = useState<React.ComponentType | null>(null);

	useEffect(() => {
		import("./../_components/GlobalUploadProgressBar")
			.then((mod) => setBar(() => mod.GlobalUploadProgressBar))
			.catch(() => {});
	}, []);

	if (!Bar) return null;
	return <Bar />;
}
