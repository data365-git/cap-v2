ALTER TABLE `videos` ADD `context` varchar(16) NOT NULL DEFAULT 'instruction';--> statement-breakpoint
ALTER TABLE `folders` ADD `context` varchar(16) NOT NULL DEFAULT 'instruction';--> statement-breakpoint
CREATE INDEX `video_context_idx` ON `videos` (`context`);--> statement-breakpoint
UPDATE `videos` SET `context` = 'meeting'
WHERE JSON_UNQUOTE(JSON_EXTRACT(`source`, '$.type')) = 'extensionWeb'
  AND JSON_UNQUOTE(JSON_EXTRACT(`source`, '$.context')) = 'meeting';
