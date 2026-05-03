import {
  Controller,
  DefaultValuePipe,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { MatchesService } from './services/matches.service';

@Controller('matches')
export class MatchesController {
  constructor(private readonly matchesService: MatchesService) {}

  @Get(':id/replay')
  async getReplay(
    @Param('id') id: string,
    @Query('cursor', new DefaultValuePipe(0), ParseIntPipe) cursor: number,
    @Query('limit', new DefaultValuePipe(24), ParseIntPipe) limit: number,
  ) {
    const replay = await this.matchesService.getMatchReplay(id, { cursor, limit });
    if (!replay) {
      throw new NotFoundException('Match replay not found.');
    }

    return replay;
  }
}
