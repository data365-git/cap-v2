import { Button } from "@cap/ui";
import { Loader2Icon } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

interface CommentInputProps {
	onSubmit?: (content: string) => void | Promise<void>;
	onCancel?: () => void;
	placeholder?: string;
	showCancelButton?: boolean;
	buttonLabel?: string;
	autoFocus?: boolean;
	disabled?: boolean;
	defaultValue?: string;
}

const CommentInput: React.FC<CommentInputProps> = ({
	onSubmit,
	onCancel,
	placeholder,
	showCancelButton = false,
	buttonLabel = "Reply",
	autoFocus = false,
	disabled,
	defaultValue = "",
}) => {
	const [content, setContent] = useState(defaultValue);
	const [pending, setPending] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (autoFocus && inputRef.current) {
			inputRef.current.focus();
		}
	}, [autoFocus]);

	const handleSubmit = async (e?: React.FormEvent) => {
		e?.preventDefault();
		if (!content.trim() || pending) return;
		setPending(true);
		try {
			await onSubmit?.(content);
			setContent("");
		} finally {
			setPending(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div className="flex items-start space-x-3">
			<div className="flex-1">
				<label htmlFor="comment-input" className="sr-only">
					Write a comment
				</label>
				<div className="p-2 rounded-lg border bg-gray-1 border-gray-5">
					<textarea
						ref={inputRef}
						id="comment-input"
						data-comment-input
						value={content}
						disabled={disabled || pending}
						onChange={(e) => setContent(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={placeholder || "Leave a comment..."}
						className={`w-full placeholder:text-gray-8 text-sm leading-[22px] text-gray-12 bg-transparent focus:outline-none transition-opacity${pending ? " opacity-60" : ""}`}
						aria-label="Write a comment"
					/>
					<div className="flex items-center mt-2 space-x-2">
						<Button
							size="xs"
							variant="primary"
							onClick={() => handleSubmit()}
							disabled={!content || pending}
						>
							{pending ? (
								<Loader2Icon className="size-3 animate-spin" />
							) : (
								buttonLabel
							)}
						</Button>
						{showCancelButton && onCancel && (
							<Button size="xs" variant="outline" onClick={onCancel}>
								Cancel
							</Button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};

export default CommentInput;
