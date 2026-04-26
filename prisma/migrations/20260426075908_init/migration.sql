-- AlterTable
ALTER TABLE "Ball" ALTER COLUMN "runs" SET DEFAULT 0,
ALTER COLUMN "batsman_id" DROP NOT NULL,
ALTER COLUMN "bowler_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Innings" ALTER COLUMN "batting_team_id" DROP NOT NULL;
