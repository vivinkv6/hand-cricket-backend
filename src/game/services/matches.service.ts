import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RoomState, MatchResult, TossState, TeamState, PlayerState, InningsState } from '../types/game.types';

@Injectable()
export class MatchesService {
  private readonly logger = new Logger(MatchesService.name);

  constructor(private prisma: PrismaService) {}

  private getTeamDbId(matchId: string, teamId: string) {
    return `team_${teamId}_${matchId}`;
  }

  private getInningsDbId(matchId: string, teamId: string) {
    return `${teamId}_${matchId}`;
  }

  // ============ MATCH MANAGEMENT ============

  async createMatchRecord(room: RoomState) {
    try {
      await this.prisma.$transaction(async (tx) => {
        // Create teams
        for (const team of room.teams) {
          // Create or get players
          for (const player of room.players.filter(p => p.teamId === team.id)) {
            await tx.player.upsert({
              where: { id: player.id },
              update: { name: player.name },
              create: { id: player.id, name: player.name }
            });
          }

          await tx.team.upsert({
            where: { id: this.getTeamDbId(room.id, team.id) },
            update: { name: team.name, captainId: team.captainId },
            create: {
              id: this.getTeamDbId(room.id, team.id),
              name: team.name,
              captainId: team.captainId
            }
          });
        }

        // Create match with toss info if available
        const matchData: any = {
          id: room.id,
          teamAId: this.getTeamDbId(room.id, 'A'),
          teamBId: this.getTeamDbId(room.id, 'B'),
          status: 'ONGOING',
        };

        if (room.toss) {
          const winnerTeam = room.teams.find(t => t.id === room.toss!.winnerTeamId);
          const loserTeam = room.teams.find(t => t.id !== room.toss!.winnerTeamId);
          matchData.tossWinnerTeamId = room.toss.winnerTeamId;
          matchData.tossWinnerName = winnerTeam?.name || 'Team ' + room.toss.winnerTeamId;
          matchData.tossDecision = room.toss.choice;
          matchData.tossLoserName = loserTeam?.name || 'Team ' + (room.toss.winnerTeamId === 'A' ? 'B' : 'A');
        }

        await tx.match.upsert({
          where: { id: room.id },
          update: matchData,
          create: matchData
        });

        // Create innings if game already started
        if (room.innings) {
          await this.startInnings(room.id, room.innings.number, room.innings.battingTeamId);
        }
      });
    } catch (e) {
      this.logger.error(`Failed to create match: ${e.message}`);
    }
  }

  // ============ INNINGS MANAGEMENT ============

  async startInnings(matchId: string, inningsNumber: number, battingTeamId: string) {
    try {
      await this.prisma.innings.upsert({
        where: { id: this.getInningsDbId(matchId, battingTeamId) },
        update: { 
          number: inningsNumber,
          battingTeamId: this.getTeamDbId(matchId, battingTeamId),
          totalRuns: 0,
          wickets: 0,
          overs: 0,
          currentOverBalls: 0,
        },
        create: {
          id: this.getInningsDbId(matchId, battingTeamId),
          matchId: matchId,
          number: inningsNumber,
          battingTeamId: this.getTeamDbId(matchId, battingTeamId),
          totalRuns: 0,
          wickets: 0,
          overs: 0,
          currentOverBalls: 0,
        }
      });
    } catch (e) {
      this.logger.error(`Failed to start innings: ${e.message}`);
    }
  }

  // ============ BALL/PLAYER STATS ============

  async saveBall(
    matchId: string, 
    battingTeamId: string, 
    ballData: {
      batsmanId: string;
      bowlerId: string;
      runs: number;
      isWicket: boolean;
      playerNameMap?: Record<string, string>;
    },
    inningsNumber?: number
  ) {
    try {
      const inningsId = this.getInningsDbId(matchId, battingTeamId);
      
      // Ensure players exist
      await this.prisma.player.upsert({
        where: { id: ballData.batsmanId },
        update: {},
        create: { id: ballData.batsmanId, name: ballData.playerNameMap?.[ballData.batsmanId] || 'Batsman' }
      });
      
      await this.prisma.player.upsert({
        where: { id: ballData.bowlerId },
        update: {},
        create: { id: ballData.bowlerId, name: ballData.playerNameMap?.[ballData.bowlerId] || 'Bowler' }
      });

      // Get or create innings
      let innings = await this.prisma.innings.findUnique({ where: { id: inningsId } });
      if (!innings) {
        await this.startInnings(matchId, inningsNumber || 1, battingTeamId);
        innings = await this.prisma.innings.findUnique({ where: { id: inningsId } });
      }

      if (!innings) {
        this.logger.error(`Innings not found: ${inningsId}`);
        return;
      }

      // Count balls for delivery number
      const existingBalls = await this.prisma.ball.count({ where: { inningsId } });
      const deliveryNumber = existingBalls + 1;

      // Create ball
      await this.prisma.ball.create({
        data: {
          inningsId,
          batsmanId: ballData.batsmanId,
          bowlerId: ballData.bowlerId,
          runs: ballData.runs,
          isWicket: ballData.isWicket,
          deliveryNumber,
          batsmanNumber: ballData.runs,
          bowlerNumber: ballData.runs,
        }
      });

      // Update innings
      const newRuns = innings.totalRuns + ballData.runs;
      const newWickets = innings.wickets + (ballData.isWicket ? 1 : 0);
      const newBalls = innings.currentOverBalls + 1;
      const newOvers = Math.floor(newBalls / 6) + (newBalls % 6) / 10;

      await this.prisma.innings.update({
        where: { id: inningsId },
        data: {
          totalRuns: newRuns,
          wickets: newWickets,
          overs: newOvers,
          currentOverBalls: newBalls % 6,
        }
      });

      // Update player stats
      await this.updatePlayerStats(matchId, ballData.batsmanId, ballData.runs, ballData.isWicket ? 0 : 1, false);
      await this.updatePlayerStats(matchId, ballData.bowlerId, 0, 0, true, ballData.runs);
    } catch (e) {
      this.logger.error(`Failed to save ball: ${e.message}`);
    }
  }

  private async updatePlayerStats(
    matchId: string, 
    playerId: string, 
    runs: number = 0, 
    balls: number = 0,
    isBowler: boolean = false,
    runsGiven: number = 0
  ) {
    try {
      const stats = await this.prisma.playerStats.findUnique({
        where: { playerId_matchId: { playerId, matchId } }
      });

      if (stats) {
        await this.prisma.playerStats.update({
          where: { playerId_matchId: { playerId, matchId } },
          data: {
            runs: stats.runs + runs,
            balls: stats.balls + balls,
            runsGiven: stats.runsGiven + runsGiven,
            wickets: isBowler ? stats.wickets + 1 : stats.wickets,
          }
        });
      } else {
        await this.prisma.playerStats.create({
          data: {
            playerId,
            matchId,
            runs,
            balls,
            runsGiven,
            wickets: isBowler ? 1 : 0,
          }
        });
      }
    } catch (e) {
      this.logger.error(`Failed to update player stats: ${e.message}`);
    }
  }

  // ============ MATCH COMPLETION ============

  async finalizeMatch(matchId: string, result: MatchResult, players: PlayerState[]) {
    try {
      await this.prisma.match.update({
        where: { id: matchId },
        data: {
          status: 'COMPLETED',
          winnerId: result.winnerTeamId,
          targetScore: result.marginType === 'runs' ? result.winningScore : undefined,
        }
      });

      // Update player stats with final scores
      for (const player of players) {
        const stats = await this.prisma.playerStats.findUnique({
          where: { playerId_matchId: { playerId: player.id, matchId } }
        });

        if (stats) {
          await this.prisma.playerStats.update({
            where: { id: stats.id },
            data: {
              runs: player.runsScored,
              balls: player.deliveriesPlayed,
              overs: player.deliveriesBowled / 6,
              runsGiven: player.runsConceded,
              wickets: player.wicketsTaken,
            }
          });
        }
      }
    } catch (e) {
      this.logger.error(`Failed to finalize match: ${e.message}`);
    }
  }

  // ============ QUERY METHODS ============

  async getMatch(matchId: string) {
    return this.prisma.match.findUnique({
      where: { id: matchId },
      include: { teamA: true, teamB: true, innings: true }
    });
  }

  async getInningsBalls(matchId: string, battingTeamId: string) {
    const inningsId = this.getInningsDbId(matchId, battingTeamId);
    return this.prisma.ball.findMany({
      where: { inningsId },
      include: { batsman: true, bowler: true },
      orderBy: { deliveryNumber: 'asc' }
    });
  }

  async getMatchStats(matchId: string) {
    return this.prisma.playerStats.findMany({
      where: { matchId },
      include: { player: true },
      orderBy: { runs: 'desc' }
    });
  }

  async getCurrentInningsNumber(matchId: string): Promise<number> {
    try {
      const innings = await this.prisma.innings.findFirst({
        where: { matchId },
        orderBy: { number: 'desc' },
        select: { number: true },
      });
      return innings?.number ?? 1;
    } catch {
      return 1;
    }
  }

  async getInningsSummary(matchId: string): Promise<{ teamId: string; runs: number; wickets: number; overs: number }[]> {
    try {
      const inningsList = await this.prisma.innings.findMany({
        where: { matchId },
        include: { battingTeam: true },
      });
      return inningsList
        .filter(i => i.battingTeamId !== null)
        .map(i => ({
          teamId: i.battingTeamId!,
          runs: i.totalRuns,
          wickets: i.wickets,
          overs: i.overs,
        }));
    } catch {
      return [];
    }
  }

  // Calculate Man of the Match
  async calculateMOM(players: any[], matchId: string) {
    if (!matchId) return null;
    
    const stats = await this.prisma.playerStats.findMany({
      where: { matchId },
      orderBy: { wickets: 'desc' }
    });

    if (stats.length === 0) return null;

    // Sort by points (runs + wickets*20)
    const sorted = stats.sort((a, b) => {
      const scoreA = (a.runs * 1) + (a.wickets * 20);
      const scoreB = (b.runs * 1) + (b.wickets * 20);
      return scoreB - scoreA;
    });

    const winner = sorted[0];
    const player = players.find(p => p.id === winner.playerId);
    
    return {
      playerId: winner.playerId,
      name: player?.name || 'Player',
      runs: winner.runs,
      wickets: winner.wickets,
    };
  }
}