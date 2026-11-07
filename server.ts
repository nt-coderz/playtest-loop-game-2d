import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { runPlaytestLoop, runFullEvaluationSuite } from './src/engine/loopController';
import { SEEDED_BUG_SCENARIOS, TEN_GAME_PROMPT_SUITE } from './src/engine/seededBugs';
import { PROMPT_TEMPLATES } from './src/engine/prompts';
import {
  deriveCustomGameDesign,
  applyBuilderOptionsToDesign,
  CustomGameDesign,
  CustomBuilderOptions,
} from './src/engine/customGameBuilder';

dotenv.config();

const PORT = 3000;
const PLAYTEST_LLM_MODEL = process.env.PLAYTEST_LLM_MODEL || 'gemini-3.8-flash';

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim() === '') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function synthesizeDesignWithGemini(
  ai: GoogleGenAI,
  userPrompt: string
): Promise<CustomGameDesign> {
  const response = await ai.models.generateContent({
    model: PLAYTEST_LLM_MODEL,
    contents: `You are a friendly 2D game designer for PlaytestLoop.
The user wants to build a 2D platformer/action game from this idea:
"${userPrompt}"

Design a cohesive visual theme, character/item names, high-contrast hex color palette, and 4 short, friendly plain-English highlights explaining how the game works and what our automated playtester verified.`,
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: 'Catchy 2-4 word game title matching the user prompt.',
          },
          genre: {
            type: Type.STRING,
            description:
              'One of: tower_climber, arena_shooter, cavern_swimmer, rooftop_runner, dungeon_labyrinth, turbo_racer, sports_striker, classic_platformer',
          },
          tagline: {
            type: Type.STRING,
            description: 'Friendly 1-sentence invitation explaining the player goal.',
          },
          heroName: { type: Type.STRING },
          collectibleName: { type: Type.STRING },
          hazardName: { type: Type.STRING },
          goalName: { type: Type.STRING },
          skyTopHex: {
            type: Type.STRING,
            description: 'Dark atmospheric background hex color e.g. #090D16',
          },
          wallFillHex: {
            type: Type.STRING,
            description: 'Solid platform fill hex color e.g. #1E293B',
          },
          wallStrokeHex: {
            type: Type.STRING,
            description: 'Platform border accent hex color e.g. #38BDF8',
          },
          playerFillHex: {
            type: Type.STRING,
            description: 'Vibrant player character hex color e.g. #38BDF8',
          },
          pickupFillHex: {
            type: Type.STRING,
            description: 'Bright collectible hex color e.g. #FACC15',
          },
          hazardFillHex: {
            type: Type.STRING,
            description: 'Distinct hazard hex color e.g. #F43F5E',
          },
          goalFillHex: {
            type: Type.STRING,
            description: 'Bright exit portal hex color e.g. #10B981',
          },
          heroShape: {
            type: Type.STRING,
            description: 'One of: astronaut, animal, knight, vehicle, wizard, robot',
          },
          collectibleShape: {
            type: Type.STRING,
            description: 'One of: star, gem, coin, food, orb',
          },
          hazardShape: {
            type: Type.STRING,
            description: 'One of: spikes, creature, fire, laser',
          },
          goalShape: {
            type: Type.STRING,
            description: 'One of: portal, chest, flag, vessel',
          },
          backdropStyle: {
            type: Type.STRING,
            description: 'One of: space, forest, ocean, volcano, cyber, castle, kitchen, sky',
          },
          hasShooting: {
            type: Type.BOOLEAN,
            description: 'True if the prompt mentions shooting, blasting, lasers, spells, or fireballs',
          },
          canSwimOrFly: {
            type: Type.BOOLEAN,
            description: 'True if the prompt involves swimming underwater, flying, or zero-g jetpacks',
          },
          friendlyHighlights: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '4 plain-English bullet points for non-coders referencing their exact prompt elements.',
          },
        },
        required: [
          'title',
          'genre',
          'tagline',
          'heroName',
          'collectibleName',
          'hazardName',
          'goalName',
          'friendlyHighlights',
        ],
      },
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim());
  const isHex = (v: unknown): v is string =>
    typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v.trim());

  const validGenres = [
    'tower_climber',
    'arena_shooter',
    'cavern_swimmer',
    'rooftop_runner',
    'dungeon_labyrinth',
    'turbo_racer',
    'sports_striker',
    'classic_platformer',
  ] as const;
  const validHeroShapes = ['astronaut', 'animal', 'knight', 'vehicle', 'wizard', 'robot'] as const;
  const validPickupShapes = ['star', 'gem', 'coin', 'food', 'orb'] as const;
  const validHazardShapes = ['spikes', 'creature', 'fire', 'laser'] as const;
  const validGoalShapes = ['portal', 'chest', 'flag', 'vessel'] as const;
  const validBackdrops = [
    'space',
    'forest',
    'ocean',
    'volcano',
    'cyber',
    'castle',
    'kitchen',
    'sky',
  ] as const;

  const base = deriveCustomGameDesign(userPrompt);
  return deriveCustomGameDesign(userPrompt, {
    title: parsed.title || base.title,
    genre: validGenres.includes(parsed.genre) ? parsed.genre : base.genre,
    tagline: parsed.tagline || base.tagline,
    heroName: parsed.heroName || base.heroName,
    collectibleName: parsed.collectibleName || base.collectibleName,
    hazardName: parsed.hazardName || base.hazardName,
    goalName: parsed.goalName || base.goalName,
    heroShape: validHeroShapes.includes(parsed.heroShape) ? parsed.heroShape : base.heroShape,
    collectibleShape: validPickupShapes.includes(parsed.collectibleShape)
      ? parsed.collectibleShape
      : base.collectibleShape,
    hazardShape: validHazardShapes.includes(parsed.hazardShape)
      ? parsed.hazardShape
      : base.hazardShape,
    goalShape: validGoalShapes.includes(parsed.goalShape) ? parsed.goalShape : base.goalShape,
    backdropStyle: validBackdrops.includes(parsed.backdropStyle)
      ? parsed.backdropStyle
      : base.backdropStyle,
    hasShooting: typeof parsed.hasShooting === 'boolean' ? parsed.hasShooting : base.hasShooting,
    canSwimOrFly: typeof parsed.canSwimOrFly === 'boolean' ? parsed.canSwimOrFly : base.canSwimOrFly,
    palette: {
      ...base.palette,
      skyTop: isHex(parsed.skyTopHex) ? parsed.skyTopHex : base.palette.skyTop,
      wallFill: isHex(parsed.wallFillHex) ? parsed.wallFillHex : base.palette.wallFill,
      wallStroke: isHex(parsed.wallStrokeHex) ? parsed.wallStrokeHex : base.palette.wallStroke,
      playerFill: isHex(parsed.playerFillHex) ? parsed.playerFillHex : base.palette.playerFill,
      pickupFill: isHex(parsed.pickupFillHex) ? parsed.pickupFillHex : base.palette.pickupFill,
      hazardFill: isHex(parsed.hazardFillHex) ? parsed.hazardFillHex : base.palette.hazardFill,
      goalFill: isHex(parsed.goalFillHex) ? parsed.goalFillHex : base.palette.goalFill,
    },
    friendlyHighlights:
      Array.isArray(parsed.friendlyHighlights) && parsed.friendlyHighlights.length > 0
        ? parsed.friendlyHighlights.slice(0, 4)
        : base.friendlyHighlights,
    poweredByGemini: true,
  });
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const runsDir = path.resolve(process.cwd(), 'runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }

  app.get('/api/seeded-bugs', (_req, res) => {
    res.json({
      scenarios: SEEDED_BUG_SCENARIOS,
      promptsSuite: TEN_GAME_PROMPT_SUITE,
      promptTemplates: PROMPT_TEMPLATES,
    });
  });

  app.get('/api/eval', (_req, res) => {
    try {
      const metrics = runFullEvaluationSuite();
      fs.writeFileSync(
        path.join(runsDir, 'eval_metrics.json'),
        JSON.stringify(metrics, null, 2),
        'utf-8'
      );
      res.json(metrics);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/loop/run', async (req, res) => {
    try {
      const {
        prompt,
        seededBugId,
        maxIterations = 8,
        useLlm = true,
        builderOptions,
      } = (req.body || {}) as {
        prompt?: string;
        seededBugId?: string;
        maxIterations?: number;
        useLlm?: boolean;
        builderOptions?: CustomBuilderOptions;
      };
      const safePrompt =
        typeof prompt === 'string' && prompt.trim().length > 0
          ? prompt.trim()
          : 'A space astronaut hopping across lunar craters, collecting star crystals, dodging plasma vents, and reaching the warp pod.';

      let customDesign = deriveCustomGameDesign(safePrompt);
      const ai = useLlm ? getGenAIClient() : null;
      if (ai) {
        try {
          customDesign = await synthesizeDesignWithGemini(ai, safePrompt);
        } catch {
          // Gracefully fall back to deterministic theme synthesis if API key is unconfigured or offline
          customDesign = deriveCustomGameDesign(safePrompt);
        }
      }
      customDesign = applyBuilderOptionsToDesign(customDesign, builderOptions);

      const report = runPlaytestLoop({
        prompt: safePrompt,
        seededBugId: typeof seededBugId === 'string' && seededBugId ? seededBugId : undefined,
        maxIterations: Number(maxIterations) || 8,
        customDesign,
      });

      fs.writeFileSync(
        path.join(runsDir, 'latest_report.json'),
        JSON.stringify(report, null, 2),
        'utf-8'
      );
      fs.writeFileSync(path.join(runsDir, 'latest_report.md'), report.markdownReport, 'utf-8');

      res.json(report);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PlaytestLoop full-stack server running on http://localhost:${PORT}`);
  });
}

startServer();
