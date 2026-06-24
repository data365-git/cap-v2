import { Button } from "@cap/ui";
import type React from "react";
import { useEffect, useRef, useState } from "react";

interface CommentInputProps {
	onSubmit?: (content: string) => void;
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
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (autoFocus && inputRef.current) {
			inputRef.current.focus();
		}
	}, [autoFocus]);

	const handleSubmit = (e?: React.FormEvent) => {
		e?.preventDefault();
		if (content.trim()) {
			onSubmit?.(content);
			setContent("");
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
						disabled={disabled}
						onChange={(e) => setContent(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={placeholder || "Leave a comment..."}
						className="w-full placeholder:text-gray-8 text-sm leading-[22px] text-gray-12 bg-transparent focus:outline-none"
						aria-label="Write a comment"
					/>
					<div className="flex items-center mt-2 space-x-2">
						<Button
							size="xs"
							variant="primary"
							onClick={() => handleSubmit()}
							disabled={!content}
						>
							{buttonLabel}
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
