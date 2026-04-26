-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "socketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "roomCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "teamSize" INTEGER NOT NULL DEFAULT 1,
    "maxPlayers" INTEGER NOT NULL DEFAULT 2,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "role" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "isOut" BOOLEAN NOT NULL DEFAULT false,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "teamId" TEXT,
    "connected" BOOLEAN NOT NULL DEFAULT true,
    "state" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_state" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "currentBall" INTEGER NOT NULL DEFAULT 1,
    "currentOver" INTEGER NOT NULL DEFAULT 1,
    "totalBalls" INTEGER NOT NULL DEFAULT 0,
    "inningsNumber" INTEGER NOT NULL DEFAULT 1,
    "strikerId" TEXT,
    "bowlerId" TEXT,
    "lastAction" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ball_history" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "inningsNumber" INTEGER NOT NULL,
    "ballNumber" INTEGER NOT NULL,
    "overNumber" INTEGER NOT NULL,
    "ballInOver" INTEGER NOT NULL,
    "batterId" TEXT,
    "bowlerId" TEXT,
    "batterChoice" INTEGER NOT NULL,
    "bowlerChoice" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "runsScored" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ball_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rooms_roomCode_key" ON "rooms"("roomCode");

-- CreateIndex
CREATE INDEX "rooms_roomCode_idx" ON "rooms"("roomCode");

-- CreateIndex
CREATE INDEX "players_roomId_idx" ON "players"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "players_roomId_userId_key" ON "players"("roomId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "game_state_roomId_key" ON "game_state"("roomId");

-- CreateIndex
CREATE INDEX "ball_history_roomId_createdAt_idx" ON "ball_history"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ball_history_roomId_inningsNumber_ballNumber_key" ON "ball_history"("roomId", "inningsNumber", "ballNumber");

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "game_state" ADD CONSTRAINT "game_state_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ball_history" ADD CONSTRAINT "ball_history_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
