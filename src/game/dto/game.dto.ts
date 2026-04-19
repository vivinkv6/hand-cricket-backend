import type { GameMode, TeamId, TossChoice } from '../types/game.types';

export interface CreateRoomDto {
  mode: GameMode;
  playerName: string;
  teamSize?: number;
}

export interface JoinRoomDto {
  roomId: string;
  playerName: string;
  playerId?: string;
}

export interface RejoinRoomDto {
  roomId: string;
  playerId: string;
}

export interface RoomPlayerActionDto {
  roomId: string;
  playerId: string;
}

export interface SelectNumberDto extends RoomPlayerActionDto {
  number: number;
}

export interface SelectBowlerDto extends RoomPlayerActionDto {
  bowlerId: string;
}

export interface SwapTeamDto extends RoomPlayerActionDto {
  targetTeamId: TeamId;
}

export interface RenameTeamDto extends RoomPlayerActionDto {
  teamId: TeamId;
  name: string;
}

export interface RematchRequestDto extends RoomPlayerActionDto {
  preference: 'same' | 'swap';
}

export interface SelectTossDto extends RoomPlayerActionDto {
  choice: TossChoice;
}
