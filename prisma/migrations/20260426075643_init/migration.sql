/*
  Warnings:

  - You are about to drop the column `batsmanId` on the `Ball` table. All the data in the column will be lost.
  - You are about to drop the column `bowlerId` on the `Ball` table. All the data in the column will be lost.
  - You are about to drop the column `inningsId` on the `Ball` table. All the data in the column will be lost.
  - You are about to drop the column `battingTeamId` on the `Innings` table. All the data in the column will be lost.
  - You are about to drop the column `matchId` on the `Innings` table. All the data in the column will be lost.
  - Added the required column `batsman_id` to the `Ball` table without a default value. This is not possible if the table is not empty.
  - Added the required column `bowler_id` to the `Ball` table without a default value. This is not possible if the table is not empty.
  - Added the required column `innings_id` to the `Ball` table without a default value. This is not possible if the table is not empty.
  - Added the required column `batting_team_id` to the `Innings` table without a default value. This is not possible if the table is not empty.
  - Added the required column `match_id` to the `Innings` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Ball" DROP CONSTRAINT "Ball_batsmanId_fkey";

-- DropForeignKey
ALTER TABLE "Ball" DROP CONSTRAINT "Ball_bowlerId_fkey";

-- DropForeignKey
ALTER TABLE "Ball" DROP CONSTRAINT "Ball_inningsId_fkey";

-- DropForeignKey
ALTER TABLE "Innings" DROP CONSTRAINT "Innings_battingTeamId_fkey";

-- DropForeignKey
ALTER TABLE "Innings" DROP CONSTRAINT "Innings_matchId_fkey";

-- DropForeignKey
ALTER TABLE "Team" DROP CONSTRAINT "Team_captainId_fkey";

-- AlterTable
ALTER TABLE "Ball" DROP COLUMN "batsmanId",
DROP COLUMN "bowlerId",
DROP COLUMN "inningsId",
ADD COLUMN     "batsman_id" TEXT NOT NULL,
ADD COLUMN     "bowler_id" TEXT NOT NULL,
ADD COLUMN     "innings_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Innings" DROP COLUMN "battingTeamId",
DROP COLUMN "matchId",
ADD COLUMN     "batting_team_id" TEXT NOT NULL,
ADD COLUMN     "match_id" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Team" ALTER COLUMN "captainId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Player_name_idx" ON "Player"("name");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_captainId_fkey" FOREIGN KEY ("captainId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Innings" ADD CONSTRAINT "Innings_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Innings" ADD CONSTRAINT "Innings_batting_team_id_fkey" FOREIGN KEY ("batting_team_id") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ball" ADD CONSTRAINT "Ball_innings_id_fkey" FOREIGN KEY ("innings_id") REFERENCES "Innings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ball" ADD CONSTRAINT "Ball_batsman_id_fkey" FOREIGN KEY ("batsman_id") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ball" ADD CONSTRAINT "Ball_bowler_id_fkey" FOREIGN KEY ("bowler_id") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;
