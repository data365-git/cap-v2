import { Comment, User, type Video } from "@cap/web-domain";
import { faCommentSlash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useSearchParams } from "next/navigation";
import type React from "react";
import {
	type ComponentProps,
	forwardRef,
	type PropsWithChildren,
	startTransition,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";

// ── Undo-delete snackbar types ─────────────────────────────────────────────
interface PendingDelete {
	commentId: Comment.CommentId;
	parentId: Comment.CommentId | null;
	/** Original comment list snapshot used to restore on Undo */
	snapshot: CommentType[];
	timerId: ReturnType<typeof setTimeout>;
}
import { deleteComment } from "@/actions/videos/delete-comment";
import { newComment } from "@/actions/videos/new-comment";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import type { CommentType } from "../../../Share";
import CommentComponent from "./Comment";
import CommentInput from "./CommentInput";
import EmptyState from "./EmptyState";

export const Comments = Object.assign(
	forwardRef<
		{ scrollToBottom: () => void },
		{
			setComments: React.Dispatch<React.SetStateAction<CommentType[]>>;
			videoId: Video.VideoId;
			optimisticComments: CommentType[];
			setOptimisticComments: (newComment: CommentType) => void;
			handleCommentSuccess: (comment: CommentType) => void;
			onSeek?: (time: number) => void;
			setShowAuthOverlay: (v: boolean) => void;
			commentsDisabled: boolean;
			videoOwnerId?: string | null;
		}
	>((props, ref) => {
		const {
			optimisticComments,
			setOptimisticComments,
			setComments,
			handleCommentSuccess,
			onSeek,
			commentsDisabled,
			videoOwnerId,
		} = props;
		const commentParams = useSearchParams().get("comment");
		const replyParams = useSearchParams().get("reply");
		const user = useCurrentUser();

		const [replyingTo, setReplyingTo] = useState<Comment.CommentId | null>(
			null,
		);

		// ── Comment-delete undo snackbar ─────────────────────────────────────
		const COMMENT_UNDO_MS = 4000;
		const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
		const pendingDeleteRef = useRef<PendingDelete | null>(null);

		const commentsContainerRef = useRef<HTMLDivElement>(null);

		useEffect(() => {
			if (commentParams || replyParams) return;
			if (commentsContainerRef.current) {
				commentsContainerRef.current.scrollTop =
					commentsContainerRef.current.scrollHeight;
			}
		}, [commentParams, replyParams]);

		const scrollToBottom = useCallback(() => {
			if (commentsContainerRef.current) {
				commentsContainerRef.current.scrollTo({
					top: commentsContainerRef.current.scrollHeight,
					behavior: "smooth",
				});
			}
		}, []);

		useImperativeHandle(ref, () => ({ scrollToBottom }), [scrollToBottom]);

		const rootComments = optimisticComments.filter(
			(comment) => !comment.parentCommentId || comment.parentCommentId === "",
		);

		const handleNewComment = async (content: string) => {
			const videoElement = document.querySelector("video") as HTMLVideoElement;
			const currentTime = videoElement?.currentTime || 0;

			const optimisticComment: CommentType = {
				id: Comment.CommentId.make(`temp-${Date.now()}`),
				authorId: User.UserId.make(user ? user.id : "anonymous"),
				authorName: user ? user.name : "Guest",
				authorImage: user ? user.imageUrl : null,
				content,
				createdAt: new Date(),
				videoId: props.videoId,
				parentCommentId: Comment.CommentId.make(""),
				type: "text",
				timestamp: currentTime,
				updatedAt: new Date(),
				sending: true,
			};

			startTransition(() => {
				setOptimisticComments(optimisticComment);
			});

			try {
				const data = await newComment({
					content,
					videoId: props.videoId,
					authorImage: user ? user.imageUrl : null,
					parentCommentId: Comment.CommentId.make(""),
					type: "text",
					timestamp: currentTime,
				});
				handleCommentSuccess(data);
			} catch (error) {
				console.error("Error posting comment:", error);
			}
		};

		const handleReply = async (content: string) => {
			if (!replyingTo || !user) return;

			const videoElement = document.querySelector("video") as HTMLVideoElement;
			const currentTime = videoElement?.currentTime || 0;

			const parentComment = optimisticComments.find((c) => c.id === replyingTo);
			const actualParentId = parentComment?.parentCommentId
				? parentComment.parentCommentId
				: replyingTo;

			const optimisticReply: CommentType = {
				id: Comment.CommentId.make(`temp-reply-${Date.now()}`),
				authorId: user.id,
				authorName: user.name,
				authorImage: user.imageUrl,
				content,
				createdAt: new Date(),
				videoId: props.videoId,
				parentCommentId: actualParentId,
				type: "text",
				timestamp: currentTime,
				updatedAt: new Date(),
				sending: true,
			};

			startTransition(() => {
				setOptimisticComments(optimisticReply);
			});

			try {
				const data = await newComment({
					content,
					videoId: props.videoId,
					parentCommentId: actualParentId,
					type: "text",
					timestamp: currentTime,
					authorImage: user.imageUrl,
				});

				handleCommentSuccess(data);

				const newReplyElement = document.getElementById(`comment-${data.id}`);
				if (newReplyElement) {
					newReplyElement.scrollIntoView({
						behavior: "smooth",
						block: "center",
					});
				}
				setReplyingTo(null);
			} catch (error) {
				console.error("Error posting reply:", error);
			}
		};

		const handleCancelReply = () => {
			setReplyingTo(null);
		};

		const commitDelete = useCallback(
			async (commentId: Comment.CommentId, parentId: Comment.CommentId | null) => {
				try {
					await deleteComment({ commentId, parentId, videoId: props.videoId });
				} catch (error) {
					console.error("Failed to delete comment:", error);
				}
			},
			[props.videoId],
		);

		const handleDeleteComment = useCallback(
			(commentId: Comment.CommentId, parentId: Comment.CommentId | null) => {
				// Cancel any in-flight pending delete (commit it immediately)
				if (pendingDeleteRef.current) {
					clearTimeout(pendingDeleteRef.current.timerId);
					void commitDelete(
						pendingDeleteRef.current.commentId,
						pendingDeleteRef.current.parentId,
					);
					pendingDeleteRef.current = null;
					setPendingDelete(null);
				}

				// Snapshot before optimistic removal
				const snapshot = optimisticComments.slice();

				// Optimistically hide the comment from the list
				setComments((prev) => prev.filter((c) => c.id !== commentId));

				// Arm the 4-second timer; commit only if not undone before it fires.
				const timerId = setTimeout(() => {
					setPendingDelete(null);
					pendingDeleteRef.current = null;
					void commitDelete(commentId, parentId);
				}, COMMENT_UNDO_MS);

				const pending: PendingDelete = { commentId, parentId, snapshot, timerId };
				pendingDeleteRef.current = pending;
				setPendingDelete(pending);
			},
			[commitDelete, optimisticComments],
		);

		const handleUndoDelete = useCallback(() => {
			if (!pendingDeleteRef.current) return;
			clearTimeout(pendingDeleteRef.current.timerId);
			// Restore original comment list
			setComments(pendingDeleteRef.current.snapshot);
			pendingDeleteRef.current = null;
			setPendingDelete(null);
		}, [setComments]);

		const handleEditComment = (
			commentId: Comment.CommentId,
			newContent: string,
		) => {
			setComments((prev) =>
				prev.map((c) =>
					c.id === commentId
						? { ...c, content: newContent, updatedAt: new Date() }
						: c,
				),
			);
		};

		return (
			<Comments.Shell
				commentInputProps={{
					onSubmit: handleNewComment,
					disabled: commentsDisabled,
				}}
				setShowAuthOverlay={props.setShowAuthOverlay}
				commentsContainerRef={commentsContainerRef}
			>
				{commentsDisabled ? (
					<div className="p-4 space-y-6 h-full">
						<EmptyState
							icon={<FontAwesomeIcon icon={faCommentSlash} />}
							commentsDisabled={commentsDisabled}
						/>
					</div>
				) : rootComments.length === 0 ? (
					<EmptyState />
				) : (
					<div className="p-4 space-y-6">
						<style>{`
							@keyframes comment-in {
								from { opacity: 0; transform: translateY(8px); }
								to   { opacity: 1; transform: translateY(0); }
							}
						`}</style>
						{rootComments.map((comment, index) => (
							<div
								key={comment.id}
								style={{
									animation: "comment-in 0.3s ease-out both",
									animationDelay: `${Math.min(index, 4) * 50}ms`,
								}}
							>
								<CommentComponent
									comment={comment}
									replies={optimisticComments}
									onReply={(id) => {
										if (!user) {
											props.setShowAuthOverlay(true);
										} else {
											setReplyingTo(id);
										}
									}}
									replyingToId={replyingTo}
									handleReply={handleReply}
									onCancelReply={handleCancelReply}
									onDelete={handleDeleteComment}
									onEditSuccess={handleEditComment}
									videoOwnerId={videoOwnerId}
									onSeek={onSeek}
								/>
							</div>
						))}
					</div>
				)}
			{/* 4-second undo snackbar for comment delete */}
			{pendingDelete && (
				<div
					style={{
						position: "fixed",
						bottom: 24,
						left: "50%",
						transform: "translateX(-50%)",
						zIndex: 9999,
						background: "rgba(17,24,39,0.96)",
						backdropFilter: "blur(12px)",
						color: "#f9fafb",
						borderRadius: 999,
						padding: "10px 20px",
						fontSize: 13,
						fontWeight: 500,
						display: "flex",
						alignItems: "center",
						gap: 12,
						boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
						whiteSpace: "nowrap",
					}}
				>
					Izoh o&apos;chirildi
					<button
						type="button"
						onClick={handleUndoDelete}
						style={{
							background: "none",
							border: "none",
							color: "#60a5fa",
							fontWeight: 700,
							fontSize: 13,
							cursor: "pointer",
							padding: 0,
							textDecoration: "underline",
							fontFamily: "inherit",
						}}
					>
						Bekor qilish
					</button>
				</div>
			)}
			</Comments.Shell>
		);
	}),
	{
		Shell: (
			props: PropsWithChildren<{
				setShowAuthOverlay: (v: boolean) => void;
				commentInputProps?: Omit<
					ComponentProps<typeof CommentInput>,
					"user" | "placholder" | "buttonLabel"
				>;
				commentsContainerRef?: React.RefObject<HTMLDivElement | null>;
			}>,
		) => {
			return (
				<>
					<div
						ref={props.commentsContainerRef}
						className="overflow-y-auto flex-1 min-h-0"
					>
						{props.children}
					</div>

					{!props.commentInputProps?.disabled && (
						<div className="flex-none p-2 border-t border-gray-5 bg-gray-2">
							<CommentInput
								{...props.commentInputProps}
								placeholder="Leave a comment"
								buttonLabel="Comment"
							/>
						</div>
					)}
				</>
			);
		},
		Skeleton: (props: { setShowAuthOverlay: (v: boolean) => void }) => (
			<Comments.Shell {...props} commentInputProps={{ disabled: true }} />
		),
	},
);
