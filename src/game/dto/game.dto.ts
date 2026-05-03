import { IsString, IsOptional, IsEnum, IsUUID, IsNumber, Min, Max, Length, IsIn } from 'class-validator';
import type { ClientRole, GameMode, TeamId, TossChoice } from '../types/game.types';

export class CreateRoomDto {
  @IsEnum(['solo', 'duel', 'team'])
  mode!: GameMode;

  @IsString()
  @Length(1, 24)
  playerName!: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(5)
  teamSize?: number;
}

export class JoinRoomDto {
  @IsString()
  @Length(4, 8)
  roomId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 24)
  playerName!: string;

  @IsOptional()
  @IsUUID()
  playerId?: string;

  @IsOptional()
  @IsIn(['player', 'spectator'])
  role?: ClientRole;
}

export class RejoinRoomDto {
  @IsString()
  @Length(4, 8)
  roomId!: string;

  @IsOptional()
  @IsUUID()
  playerId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 24)
  playerName?: string;
}

export class LeaveRoomDto {
  @IsString()
  @Length(4, 8)
  roomId!: string;
}

export class RoomPlayerActionDto {
  @IsString()
  @Length(4, 8)
  roomId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  actionId!: string;
}

export class SelectNumberDto extends RoomPlayerActionDto {
  @IsNumber()
  @Min(1)
  @Max(6)
  number!: number;
}

export class SelectBowlerDto extends RoomPlayerActionDto {
  @IsUUID()
  bowlerId!: string;
}

export class SwapTeamDto extends RoomPlayerActionDto {
  @IsIn(['A', 'B'])
  targetTeamId!: TeamId;
}

export class RenameTeamDto extends RoomPlayerActionDto {
  @IsIn(['A', 'B'])
  teamId!: TeamId;

  @IsString()
  @Length(1, 24)
  name!: string;
}

export class RematchRequestDto extends RoomPlayerActionDto {
  @IsIn(['same', 'swap'])
  preference!: 'same' | 'swap';
}

export class SelectTossDto extends RoomPlayerActionDto {
  @IsIn(['bat', 'bowl'])
  choice!: TossChoice;
}
