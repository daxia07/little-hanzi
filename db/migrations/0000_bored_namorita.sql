CREATE TABLE `attempts` (
	`profile` text NOT NULL,
	`id` text NOT NULL,
	`created_at` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`profile`, `id`)
);
--> statement-breakpoint
CREATE TABLE `drafts` (
	`profile` text PRIMARY KEY NOT NULL,
	`updated_at` integer NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`profile` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
