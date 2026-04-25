import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RoomState, MatchResult } from '../types/game.types';

@Injectable()
export class MatchesService {
  private readonly logger = new Logger(MatchesService.name);

  constructor(private prisma: PrismaService) {}

  private getTeamDbId(matchId: string, teamId: string) {
    return `team_${teamId}_${matchId}`;
  }

  private getInningsDbId(matchId: string, teamId: string) {
    return `${teamId}${matchId}`;
  }

  async ensureMatchPrerequisites(room: RoomState) {
    try {
      for (const team of room.teams) {
        await this.prisma.team.upsert({
          where: { id: this.getTeamDbId(room.id, team.id) },
          update: { name: team.name },
          create: {
            id: this.getTeamDbId(room.id, team.id),
            name: team.name,
            captain: {
              connectOrCreate: {
                where: { id: team.captainId || `anon_${team.id}` },
                create: { 
                  id: team.captainId || `anon_${team.id}`,
                  name: room.players.find(p => p.id === team.captainId)?.name || 'Captain'
                }
              }
            }
          }
        });
      }

      await this.prisma.match.upsert({
        where: { id: room.id },
        update: { status: 'ONGOING' },
        create: {
          id: room.id,
          teamAId: this.getTeamDbId(room.id, 'A'),
          teamBId: this.getTeamDbId(room.id, 'B'),
          status: 'ONGOING',
        }
      });
    } catch (e) {
      this.logger.error(`Prerequisites check failed: ${e.message}`);
    }
  }

  async createMatchRecord(room: RoomState) {
    await this.ensureMatchPrerequisites(room);
  }

  async startInnings(matchId: string, inningsNumber: number, battingTeamId: string) {
    try {
      const id = this.getInningsDbId(matchId, battingTeamId);
      return await this.prisma.innings.upsert({
        where: { id },
        update: { number: inningsNumber },
        create: {
          id,
          matchId,
          number: inningsNumber,
          battingTeamId: this.getTeamDbId(matchId, battingTeamId),
        }
      });
    } catch (error) {
      this.logger.error(`Failed to start innings: ${error.message}`);
    }
  }

  async saveBall(matchId: string, battingTeamId: string, ballData: any) {
    try {
      const inningsId = this.getInningsDbId(matchId, battingTeamId);

      // Verify Innings existence (Critical for FK)
      const innings = await this.prisma.innings.findUnique({ where: { id: inningsId } });
      if (!innings) {
        this.logger.warn(`Innings ${inningsId} missing during saveBall. Lazy creating...`);
        await this.startInnings(matchId, 1, battingTeamId); 
      }

      // Ensure Players exist
      for (const pid of [ballData.batsmanId, ballData.bowlerId]) {
        await this.prisma.player.upsert({
          where: { id: pid },
          update: {},
          create: { id: pid, name: ballData.playerNameMap?.[pid] || 'Player' }
        });
      }

      return await this.prisma.ball.create({
        data: {
          id: `ball_${matchId}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
          inningsId,
          batsmanId: ballData.batsmanId,
          bowlerId: ballData.bowlerId,
          runs: ballData.runs,
          isWicket: ballData.isWicket,
        }
      });
    } catch (error) {
      this.logger.error(`Failed to save ball: ${error.message}`);
    }
  }

  async finalizeMatch(matchId: string, result: MatchResult, players: any[]) {
    try {
      const winnerId = result.winnerTeamId ? this.getTeamDbId(matchId, result.winnerTeamId) : null;
      
      await this.prisma.match.update({
        where: { id: matchId },
        data: {
          status: 'COMPLETED',
          winnerId: winnerId,
        }
      });

      for (const p of players) {
        await this.prisma.playerStats.upsert({
          where: { playerId_matchId: { playerId: p.id, matchId: matchId } },
          update: {
            runs: p.runsScored,
            balls: p.deliveriesPlayed,
            overs: p.deliveriesBowled / 6,
            runsGiven: p.runsConceded,
            wickets: p.wicketsTaken,
          },
          create: {
            playerId: p.id,
            matchId: matchId,
            runs: p.runsScored,
            balls: p.deliveriesPlayed,
            overs: p.deliveriesBowled / 6,
            runsGiven: p.runsConceded,
            wickets: p.wicketsTaken,
          }
        });
      }

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to finalize match: ${error.message}`);
    }
  }

  async calculateMOM(players: any[]) {
    try {
      if (!players || players.length === 0) return null;

      let momPlayer = players[0];
      let maxImpact = -1;

      players.forEach(p => {
        const impact = (p.runsScored * 1) + (p.wicketsTaken * 20);
        if (impact > maxImpact) {
          maxImpact = impact;
          momPlayer = p;
        }
      });

      return {
        id: momPlayer.id,
        name: momPlayer.name,
        runs: momPlayer.runsScored,
        wickets: momPlayer.wicketsTaken
      };
    } catch (error) {
      this.logger.error(`Failed to calculate MOM: ${error.message}`);
      return null;
    }
  }
}

