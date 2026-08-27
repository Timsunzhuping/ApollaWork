import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { loadSkills } from '@apolla/runtime';
import { AuthGuard } from '../auth/auth.js';
import { CONFIG, type AppConfig } from '../config.js';

@UseGuards(AuthGuard)
@Controller('api/v1')
export class SkillsController {
  constructor(@Inject(CONFIG) private config: AppConfig) {}

  @Get('skills')
  list() {
    const skills = loadSkills(...this.config.skillRoots);
    return skills.map((s) => ({
      name: s.name,
      description: s.description,
      scope: 'builtin',
      enabled: true,
    }));
  }
}
