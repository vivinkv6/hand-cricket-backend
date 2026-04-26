-- CreateEnum
CREATE TYPE "GameMode" AS ENUM ('SOLO', 'DUEL', 'TEAM');

-- CreateEnum
CREATE TYPE "TossChoice" AS ENUM ('BAT', 'BOWL');

-- AlterTable
ALTER TABLE "Ball" ADD COLUMN     "batsmanNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "bowlerNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "deliveryNumber" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "label" TEXT;

-- AlterTable
ALTER TABLE "Innings" ADD COLUMN     "currentOverBalls" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Match" ADD COLUMN     "targetScore" INTEGER,
ADD COLUMN     "tossDecision" "TossChoice",
ADD COLUMN     "tossLoserName" TEXT,
ADD COLUMN     "tossWinnerName" TEXT,
ADD COLUMN     "tossWinnerTeamId" TEXT;

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "teamSize" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "RoomPlayer" ADD COLUMN     "isBot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isCaptain" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "teamId" TEXT;

-- CreateIndex
CREATE INDEX "Ball_innings_id_idx" ON "Ball"("innings_id");
