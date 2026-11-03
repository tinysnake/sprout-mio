CREATE TABLE `wake_evaluation_attempt` (
	`evaluation_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	`error_code` text,
	`usage` text,
	PRIMARY KEY(`evaluation_id`, `attempt`),
	FOREIGN KEY (`evaluation_id`) REFERENCES `wake_evaluation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wake_evaluation_attempt_number_check" CHECK("wake_evaluation_attempt"."attempt" between 1 and 6),
	CONSTRAINT "wake_evaluation_attempt_outcome_check" CHECK("wake_evaluation_attempt"."outcome" is null or "wake_evaluation_attempt"."outcome" in ('decided','retry_wait','attention','stale','canceled')),
	CONSTRAINT "wake_evaluation_attempt_finish_check" CHECK(("wake_evaluation_attempt"."outcome" is null) = ("wake_evaluation_attempt"."finished_at" is null)),
	CONSTRAINT "wake_evaluation_attempt_error_check" CHECK("wake_evaluation_attempt"."error_code" is null or "wake_evaluation_attempt"."outcome" is not null)
);
