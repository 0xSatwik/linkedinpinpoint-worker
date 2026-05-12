/**
 * Cloudflare Worker for LinkedIn Pinpoint Data Scraping and Storage
 * Uses D1 database to store and retrieve pinpoint data
 * Integrates Google Gemini API for generating answer explanations
 * Scheduled trigger runs daily at 1:31 PM IST (8:01 AM UTC)
 */

// GEMINI_API_KEY should be set via `npx wrangler secret put GEMINI_API_KEY`
const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Allowed Origins for Protected Endpoints
const ALLOWED_ORIGINS = [
  'https://pinpointanswertoday.online',
  'https://www.pinpointanswertoday.online',
  'https://pinpointanswers.vercel.app',
  'https://linkedin-pinpoint-answers.pages.dev',
  'https://pinpointanswertoday.online',
  'http://localhost:3001',
  'http://localhost:3000'
];

// Also allow any Cloudflare Pages deployment subdomain for this project
function checkAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow any *.linkedin-pinpoint-answers.pages.dev subdomain
  if (origin.match(/^https:\/\/[a-z0-9-]+\.linkedin-pinpoint-answers\.pages\.dev$/)) return true;
  return false;
}

// Also allow X-API-Key header for server-side rendering
const API_KEY_HEADER = 'X-API-Key';

export default {

  async scheduled(event, env, ctx) {
    console.log('Scheduled trigger fired at:', new Date().toISOString());

    try {
      // Get the latest puzzle number from the DB to determine what's next
      const latest = await env.DB.prepare(
        'SELECT number FROM pinpoint_data ORDER BY number DESC LIMIT 1'
      ).first();

      const nextNumber = latest ? latest.number + 1 : 1;
      console.log(`Attempting to scrape pinpoint #${nextNumber}`);

      const data = await scrapeAndStorePinpoint(env, nextNumber);

      if (data && data.answer) {
        console.log(`Successfully added pinpoint #${nextNumber}: ${data.answer}`);

        // Trigger frontend rebuild via GitHub Actions
        ctx.waitUntil(triggerDeploy(env));
      } else {
        console.log(`Pinpoint #${nextNumber} not available yet or scraping failed`);
      }
    } catch (err) {
      console.error('Scheduled job error:', err.message);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;
    const origin = request.headers.get('Origin');
    const apiKeyHeader = request.headers.get(API_KEY_HEADER);

    // Check for Secret Key Bypass (Browser Access)
    let isAuthorizedBySecret = false;
    const secretKey = env.SECRET_KEY;

    if (secretKey && path.endsWith(`/${secretKey}`)) {
      isAuthorizedBySecret = true;
      path = path.substring(0, path.length - (secretKey.length + 1));
      if (path === '') path = '/';
    }

    // Also authorize via X-API-Key header (for SSR)
    if (apiKeyHeader && apiKeyHeader === secretKey) {
      isAuthorizedBySecret = true;
    }

    // CORS headers
    let corsHeaders = {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Content-Type': 'application/json',
    };

    const isAllowedOrigin = checkAllowedOrigin(origin) || isAuthorizedBySecret;

    if (isAllowedOrigin) {
      corsHeaders['Access-Control-Allow-Origin'] = origin || '*';
      corsHeaders['Vary'] = 'Origin';
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      if (isAllowedOrigin) {
        return new Response(null, { headers: corsHeaders });
      }
      return new Response(null, { status: 204 });
    }

    // Protected Endpoints List
    const protectedPrefixes = ['/today', '/yesterday', '/last', '/search'];
    const isProtectedPath = protectedPrefixes.some(prefix => path.startsWith(prefix));

    if (isProtectedPath) {
      if (!isAllowedOrigin) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Forbidden',
          message: 'Protected: Access Denied. Requests allowed only from authorized domains.'
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } else {
      if (!corsHeaders['Access-Control-Allow-Origin']) {
        corsHeaders['Access-Control-Allow-Origin'] = '*';
      }
    }

    try {
      // Root endpoint - API documentation
      if (path === '/') {
        return new Response(JSON.stringify({
          message: 'LinkedIn Pinpoint API',
          version: '2.0.0',
          access: 'Protected Endpoints: /today, /yesterday, /last, /search',
          endpoints: {
            'GET /': 'API documentation',
            'GET /today': 'Get the latest pinpoint data (Protected)',
            'GET /yesterday': 'Get the 2nd latest pinpoint data (Protected)',
            'GET /last/{limit}/{page}': 'Get latest X pinpoints (Protected)',
            'GET /search/clue?q={query}': 'Search by clue text (Protected)',
            'GET /search/answer?q={query}': 'Search by answer text (Protected)',
            'GET /search/number/{number}': 'Get data by pinpoint number (Protected)',
            'GET /search/date/{date}': 'Get data by date (Protected)',
            'GET /solutions/{number}/{offset}/{limit}': 'Get solutions batch',
            'GET /check/{number}/{word}': 'Check if word is valid solution',
            'GET /trigger-deploy': 'Trigger frontend rebuild (Secret Key)',
          }
        }, null, 2), { headers: corsHeaders });
      }

      // GET /trigger-deploy - Trigger GitHub Actions to rebuild frontend
      if (path === '/trigger-deploy') {
        if (!isAuthorizedBySecret) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Unauthorized',
            message: 'Secret key required to trigger deployments'
          }), { status: 401, headers: corsHeaders });
        }

        try {
          const result = await triggerDeploy(env);
          return new Response(JSON.stringify({
            success: true,
            message: 'Deploy triggered successfully',
            result
          }), { headers: corsHeaders });
        } catch (err) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Deploy trigger failed',
            message: err.message
          }), { status: 500, headers: corsHeaders });
        }
      }

      // GET /today - Get latest pinpoint data
      if (path === '/today') {
        const result = await env.DB.prepare(
          'SELECT * FROM pinpoint_data ORDER BY number DESC LIMIT 1'
        ).first();

        if (!result) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No data found',
            message: 'No pinpoint data available yet'
          }), { status: 404, headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          success: true,
          data: formatPuzzleResult(result)
        }), { headers: corsHeaders });
      }

      // GET /yesterday - Get 2nd latest pinpoint data
      if (path === '/yesterday') {
        const result = await env.DB.prepare(
          'SELECT * FROM pinpoint_data ORDER BY number DESC LIMIT 1 OFFSET 1'
        ).first();

        if (!result) {
          return new Response(JSON.stringify({
            success: false,
            error: 'No data found',
            message: 'No yesterday pinpoint data available yet'
          }), { status: 404, headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          success: true,
          data: formatPuzzleResult(result)
        }), { headers: corsHeaders });
      }

      // GET /last/{limit}/{page}
      const lastMatch = path.match(/^\/last\/(\d+)\/(\d+)$/);
      if (lastMatch) {
        let limit = parseInt(lastMatch[1]);
        const page = parseInt(lastMatch[2]);

        if (limit > 20) limit = 20;
        if (limit < 1) limit = 1;
        if (page < 1) {
          return new Response(JSON.stringify({
            success: false, error: 'Invalid parameter',
            message: 'Page number must be at least 1'
          }), { status: 400, headers: corsHeaders });
        }

        const offset = (page - 1) * limit;
        const results = await env.DB.prepare(
          'SELECT number, date, clues FROM pinpoint_data ORDER BY number DESC LIMIT ? OFFSET ?'
        ).bind(limit, offset).all();

        return new Response(JSON.stringify({
          success: true, limit, page,
          count: results.results.length,
          data: results.results.map(r => ({
            number: r.number,
            date: r.date,
            clues: JSON.parse(r.clues)
          }))
        }), { headers: corsHeaders });
      }

      // GET /solutions/{number}/{offset}/{limit}
      const solutionsMatch = path.match(/^\/solutions\/(\d+)\/(\d+)\/(\d+)$/);
      if (solutionsMatch) {
        const number = parseInt(solutionsMatch[1]);
        const offset = parseInt(solutionsMatch[2]);
        const limit = parseInt(solutionsMatch[3]);

        try {
          const dbResult = await env.DB.prepare(
            'SELECT other_solutions FROM pinpoint_data WHERE number = ?'
          ).bind(number).first();

          if (!dbResult) {
            return new Response(JSON.stringify({ success: false, error: 'Puzzle not found' }), { headers: corsHeaders, status: 404 });
          }

          const allSolutions = dbResult.other_solutions ? JSON.parse(dbResult.other_solutions) : [];
          const slicedSolutions = allSolutions.slice(offset, offset + limit);

          return new Response(JSON.stringify({
            success: true, data: slicedSolutions,
            total: allSolutions.length,
            hasMore: (offset + limit) < allSolutions.length
          }), { headers: corsHeaders });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { headers: corsHeaders, status: 500 });
        }
      }

      // GET /check/{number}/{word}
      const checkMatch = path.match(/^\/check\/(\d+)\/(.+)$/);
      if (checkMatch) {
        const number = parseInt(checkMatch[1]);
        const word = decodeURIComponent(checkMatch[2]).trim();

        try {
          const dbResult = await env.DB.prepare(
            'SELECT other_solutions FROM pinpoint_data WHERE number = ?'
          ).bind(number).first();

          if (!dbResult) {
            return new Response(JSON.stringify({ success: false, error: 'Puzzle not found' }), { headers: corsHeaders, status: 404 });
          }

          const allSolutions = dbResult.other_solutions ? JSON.parse(dbResult.other_solutions) : [];
          const cleanWord = word.toLowerCase().replace(/[^a-z0-9]/g, '');
          const exists = allSolutions.some(s => s.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanWord);

          return new Response(JSON.stringify({
            success: true, exists, word
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { headers: corsHeaders });
        }
      }

      // GET /add/{number}/{secretkey}
      const addMatch = path.match(/^\/add\/(\d+)(?:\/(.+))?$/);
      if (addMatch) {
        const [, number, providedKey] = addMatch;

        if (providedKey !== env.SECRET_KEY && !isAuthorizedBySecret) {
          return new Response(JSON.stringify({
            success: false, error: 'Unauthorized',
            message: 'Invalid or missing secret key'
          }), { status: 401, headers: corsHeaders });
        }

        try {
          const data = await scrapeAndStorePinpoint(env, parseInt(number));

          if (!data || !data.answer) {
            return new Response(JSON.stringify({
              success: false, error: 'Processing failed',
              message: 'Could not extract required data', data
            }), { status: 500, headers: corsHeaders });
          }

          // Trigger frontend rebuild after adding new puzzle
          ctx.waitUntil(triggerDeploy(env));

          return new Response(JSON.stringify({
            success: true, message: 'Data added/updated successfully', data
          }), { headers: corsHeaders });
        } catch (err) {
          return new Response(JSON.stringify({
            success: false, error: 'Failed to add', message: err.message
          }), { status: 500, headers: corsHeaders });
        }
      }

      // GET /delete/{number}/{secretkey}
      const deleteMatch = path.match(/^\/delete\/(\d+)(?:\/(.+))?$/);
      if (deleteMatch) {
        const [, number, providedKey] = deleteMatch;

        if (providedKey !== env.SECRET_KEY && !isAuthorizedBySecret) {
          return new Response(JSON.stringify({
            success: false, error: 'Unauthorized',
            message: 'Invalid or missing secret key'
          }), { status: 401, headers: corsHeaders });
        }

        const result = await env.DB.prepare(
          'DELETE FROM pinpoint_data WHERE number = ?'
        ).bind(parseInt(number)).run();

        if (result.meta.changes === 0) {
          return new Response(JSON.stringify({
            success: false, error: 'Not found',
            message: `No data found for pinpoint number ${number}`
          }), { status: 404, headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          success: true, message: `Pinpoint ${number} deleted successfully`
        }), { headers: corsHeaders });
      }

      // GET /search/clue?q={query}
      if (path === '/search/clue') {
        const query = url.searchParams.get('q');
        if (!query) {
          return new Response(JSON.stringify({
            success: false, error: 'Missing parameter',
            message: 'Query parameter "q" is required'
          }), { status: 400, headers: corsHeaders });
        }

        const results = await env.DB.prepare(
          'SELECT * FROM pinpoint_data WHERE clues LIKE ? ORDER BY number DESC'
        ).bind(`%${query}%`).all();

        return new Response(JSON.stringify({
          success: true, count: results.results.length,
          data: results.results.map(r => formatPuzzleResult(r))
        }), { headers: corsHeaders });
      }

      // GET /search/answer?q={query}
      if (path === '/search/answer') {
        const query = url.searchParams.get('q');
        if (!query) {
          return new Response(JSON.stringify({
            success: false, error: 'Missing parameter',
            message: 'Query parameter "q" is required'
          }), { status: 400, headers: corsHeaders });
        }

        const results = await env.DB.prepare(
          'SELECT * FROM pinpoint_data WHERE answer LIKE ? ORDER BY number DESC'
        ).bind(`%${query}%`).all();

        return new Response(JSON.stringify({
          success: true, count: results.results.length,
          data: results.results.map(r => formatPuzzleResult(r))
        }), { headers: corsHeaders });
      }

      // GET /search/number/{number}
      const numberMatch = path.match(/^\/search\/number\/(\d+)$/);
      if (numberMatch) {
        const number = parseInt(numberMatch[1]);
        const result = await env.DB.prepare(
          'SELECT * FROM pinpoint_data WHERE number = ?'
        ).bind(number).first();

        if (!result) {
          return new Response(JSON.stringify({
            success: false, error: 'Not found',
            message: `No data found for pinpoint number ${number}`
          }), { status: 404, headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          success: true, data: formatPuzzleResult(result)
        }), { headers: corsHeaders });
      }

      // GET /search/date/{date}
      const dateMatch = path.match(/^\/search\/date\/(.+)$/);
      if (dateMatch) {
        const date = dateMatch[1];
        const result = await env.DB.prepare(
          'SELECT * FROM pinpoint_data WHERE date = ?'
        ).bind(date).first();

        if (!result) {
          return new Response(JSON.stringify({
            success: false, error: 'Not found',
            message: `No data found for date ${date}`
          }), { status: 404, headers: corsHeaders });
        }

        return new Response(JSON.stringify({
          success: true, data: formatPuzzleResult(result)
        }), { headers: corsHeaders });
      }

      // 404
      return new Response(JSON.stringify({
        success: false, error: 'Not found',
        message: 'Endpoint not found',
        availableEndpoints: [
          'GET /', 'GET /today', 'GET /yesterday',
          'GET /last/{limit}/{page}',
          'GET /add/{number}/{secretkey}',
          'GET /delete/{number}/{secretkey}',
          'GET /search/clue?q={query}',
          'GET /search/answer?q={query}',
          'GET /search/number/{number}',
          'GET /search/date/{date}',
          'GET /trigger-deploy',
        ]
      }), { status: 404, headers: corsHeaders });

    } catch (error) {
      return new Response(JSON.stringify({
        success: false, error: 'Internal server error', message: error.message
      }), { status: 500, headers: corsHeaders });
    }
  },
};

/**
 * Format a DB result row into the API response shape
 */
function formatPuzzleResult(result) {
  return {
    number: result.number,
    date: result.date,
    clues: JSON.parse(result.clues),
    answer: result.answer,
    explanation: result.explanation || null,
    solutions: result.other_solutions ? JSON.parse(result.other_solutions) : [],
    totalSolutions: result.other_solutions ? JSON.parse(result.other_solutions).length : 0,
    created_at: result.created_at || undefined,
  };
}

/**
 * Trigger GitHub Actions workflow to rebuild and deploy the frontend
 */
async function triggerDeploy(env) {
  const githubToken = env.GITHUB_TOKEN;
  const frontendRepo = env.FRONTEND_REPO || 'sujitbhai7710/linkedin-pinpoint-frontend';

  if (!githubToken) {
    console.error('GITHUB_TOKEN not set, skipping deploy trigger');
    return { triggered: false, reason: 'GITHUB_TOKEN not configured' };
  }

  console.log(`Triggering deploy for ${frontendRepo}...`);

  const response = await fetch(
    `https://api.github.com/repos/${frontendRepo}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'linkedin-pinpoint-worker'
      },
      body: JSON.stringify({
        event_type: 'deploy',
        client_payload: {
          triggered_by: 'worker-cron',
          timestamp: new Date().toISOString()
        }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`GitHub dispatch failed: ${response.status} - ${errorText}`);
    throw new Error(`GitHub dispatch failed: ${response.status}`);
  }

  console.log('Deploy triggered successfully');
  return { triggered: true, repo: frontendRepo };
}

/**
 * Generate explanation for pinpoint answer using Gemini API
 * Uses human-style writing: conversational, specific, no corporate jargon
 */
async function generateExplanation(clues, answer, env) {
  const apiKeyString = env.GEMINI_API_KEY;
  if (!apiKeyString) {
    console.error('GEMINI_API_KEY not set, skipping explanation generation');
    return null;
  }

  const apiKeys = apiKeyString.split(',').map(k => k.trim()).filter(k => k.length > 0);

  if (apiKeys.length === 0) {
    console.error('No valid Gemini API keys found in GEMINI_API_KEY');
    return null;
  }

  console.log(`Starting generation with load balancing across ${apiKeys.length} keys`);

  const prompt = `You're writing for a site called Pinpoint Answer Today, where people come to check the daily LinkedIn Pinpoint answer and actually understand why it's the answer. Write like you're explaining this to a coworker who just asked "hey, what was today's Pinpoint?" over lunch. No corporate speak, no buzzwords, no "revolutionary" or "game-changing" anything.

WRITING RULES:
- Use short, punchy sentences. Mix short and medium ones. Never write a sentence over 25 words unless you absolutely must.
- Be specific. Don't say "these clues relate to the answer" — say HOW they relate. Use real examples.
- Active voice, present tense. "The clue points to X" not "X is pointed to by the clue."
- No hedging. Don't say "this might suggest" — say "this tells you."
- No transitions like "Let's dive in" or "Without further ado." Just start the next section.
- End with something useful (a tip, a pattern to watch for), not a summary paragraph.
- Replace "utilize" with "use", "in order to" with "to", "at this point in time" with "now."
- Cut "very," "really," "quite," "actually" wherever you find them.
- If you wouldn't say it in a GitHub issue comment, don't put it in this article.

Clues:
${clues.map((clue, i) => `${i + 1}. ${clue}`).join('\n')}

Answer: ${answer}

## Deep Clue Analysis
For each clue, give a tight, specific explanation of what it means and how it points to the answer. Use this format:

### ${clues[0]}
**What it means**: [plain-English meaning of "${clues[0]}" and how it connects to the answer — be specific, give an example if helpful]

### ${clues[1]}
**What it means**: [same thing for "${clues[1]}"]

### ${clues[2]}
**What it means**: [same thing for "${clues[2]}"]

### ${clues[3]}
**What it means**: [same thing for "${clues[3]}"]

### ${clues[4]}
**What it means**: [same thing for "${clues[4]}"]

## How We Solved It
Walk through the solving process like a real person playing the game. You saw clue 1, what did you think? Maybe you guessed wrong. Then clue 2 appeared, and that changed things. Keep going until all 5 clues lock in the answer. Write in multiple short paragraphs (2-3 sentences each), not one giant block.

## Lessons Learned
Give 3-4 specific, actionable takeaways from this puzzle that help with future Pinpoint puzzles. No generic advice like "think laterally" — give real patterns to watch for.

## Frequently Asked Questions
4-5 questions a real player would ask about this specific puzzle. Format:
**Q: [Specific, in-depth question]**
**A: [Direct, informative answer — no fluff]**

Remember: you're a knowledgeable peer, not a teacher. The reader plays this game too — they just need the explanation to click.`;

  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 2048,
    }
  };

  let lastError = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    const keyHint = apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);

    console.log(`[Attempt ${i + 1}/${apiKeys.length}] Using key: ${keyHint}`);

    try {
      const response = await fetch(
        `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Gemini API error for key ${keyHint}: ${response.status} - ${errorText}`);
        lastError = new Error(`Gemini API error: ${response.status} - ${errorText}`);

        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
          console.warn(`Key ${keyHint} rate-limited or unstable, trying next...`);
          continue;
        } else {
          continue;
        }
      }

      const result = await response.json();

      if (result.candidates && result.candidates[0] && result.candidates[0].content) {
        const explanation = result.candidates[0].content.parts[0].text;
        console.log(`Successfully generated explanation using key ${keyHint}`);
        return explanation;
      }

      console.error(`Unexpected Gemini API response format for key ${keyHint}`);
      lastError = new Error('Unexpected Gemini API response format');
    } catch (error) {
      console.error(`Fetch error for key ${keyHint}:`, error);
      lastError = error;
    }
  }

  console.error('All Gemini API keys failed.');
  throw lastError || new Error('All Gemini API keys failed to generate a response.');
}

/**
 * Helper to scrape and store pinpoint data
 */
async function scrapeAndStorePinpoint(env, number) {
  const scrapeUrl = `https://pinpointanswer.today/linkedin-pinpoint-answer/pinpoint-${number}/?t=${Date.now()}`;
  console.log(`Scraping URL: ${scrapeUrl}`);

  const response = await fetch(scrapeUrl, {
    headers: {
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch data from ${scrapeUrl}`);
  }

  const html = await response.text();
  const data = extractPinpointData(html, number);

  if (!data.clues || !data.answer || !data.date) {
    console.log('Incomplete data extracted:', data);
    return data;
  }

  // Generate explanation using Gemini API
  console.log('Generating explanation via Gemini API...');
  let explanation;
  try {
    explanation = await generateExplanation(data.clues, data.answer, env);
    if (!explanation) {
      throw new Error('Empty explanation generated');
    }
    data.explanation = explanation;
    console.log('Explanation generated successfully');
  } catch (err) {
    console.error('Explanation generation failed, aborting storage:', err.message);
    throw new Error(`Gemini API error: ${err.message}. Failed to add to database.`);
  }

  // Generate other_solutions if not already extracted from the source page
  let otherSolutions = data.other_solutions || [];
  if (otherSolutions.length === 0) {
    // Try competitor site first
    console.log('No solutions found in source page, trying competitor site...');
    try {
      const competitorSolutions = await extractSolutionsFromCompetitor(number);
      if (competitorSolutions.length > 0) {
        otherSolutions = competitorSolutions;
      }
    } catch (err) {
      console.error('Competitor site extraction failed:', err.message);
    }
  }

  if (otherSolutions.length === 0) {
    // Fallback: use Gemini to generate alternative valid solutions
    console.log('No solutions from external sources, generating via Gemini API...');
    try {
      const generatedSolutions = await generateSolutions(data.clues, data.answer, env);
      if (generatedSolutions.length > 0) {
        otherSolutions = generatedSolutions;
        console.log(`Generated ${generatedSolutions.length} solutions via Gemini`);
      }
    } catch (err) {
      console.error('Solution generation failed:', err.message);
    }
  }

  data.other_solutions = otherSolutions;

  // Store in database (upsert)
  await env.DB.prepare(`
    INSERT INTO pinpoint_data (number, date, clues, answer, explanation, other_solutions, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(number) 
    DO UPDATE SET 
      date = excluded.date,
      clues = excluded.clues,
      answer = excluded.answer,
      explanation = excluded.explanation,
      other_solutions = excluded.other_solutions,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    parseInt(number),
    data.date,
    JSON.stringify(data.clues),
    data.answer,
    explanation,
    otherSolutions.length > 0 ? JSON.stringify(otherSolutions) : null
  ).run();

  return data;
}

/**
 * Decode HTML entities
 */
function decodeHTMLEntities(text) {
  const entities = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#x27;': "'",
    '&#39;': "'",
    '&apos;': "'",
    '&#x2F;': '/',
    '&#47;': '/',
  };

  return text.replace(/&[#\w]+;/g, (entity) => {
    return entities[entity] || entity;
  });
}

/**
 * Extract pinpoint data from HTML
 */
function extractPinpointData(html, number) {
  const data = {
    number: parseInt(number),
    clues: [],
    answer: '',
    date: '',
    other_solutions: []
  };

  try {
    const dateMatch = html.match(/<time[^>]*datetime="([^"]+)"/i);
    if (dateMatch) {
      data.date = dateMatch[1].split('T')[0];
    }

    const clueRegex = /<div[^>]*data-clue-card="true"[^>]*>[\s\S]*?<div[^>]*>([^<]+)<\/div>\s*<\/div>/g;
    let match;
    const clues = [];

    while ((match = clueRegex.exec(html)) !== null) {
      const clueText = match[1].trim();
      if (clueText && !clueText.startsWith('#')) {
        clues.push(clueText);
      }
    }

    if (clues.length === 0) {
      const altClueRegex = /<div[^>]*class="[^"]*cursor-pointer[^"]*"[^>]*>[\s\S]*?<\/div>\s*<div[^>]*>([^<]+)<\/div>/g;
      while ((match = altClueRegex.exec(html)) !== null) {
        const clueText = match[1].trim();
        if (clueText && !clueText.startsWith('#') && clueText.length < 50) {
          clues.push(clueText);
        }
      }
    }

    data.clues = clues.map(clue => decodeHTMLEntities(clue));

    let answerMatch = html.match(/\\"answer\\":\\"([^]*?)\\",/);

    if (!answerMatch || !answerMatch[1] || answerMatch[1].length < 2) {
      answerMatch = html.match(/\\"answer\\":\\"((?:[^"\\]|\\.)*)\\"/);
    }

    if (!answerMatch || !answerMatch[1] || answerMatch[1].length < 2) {
      answerMatch = html.match(/"answer"\s*:\s*"([^"]+)"/);
    }

    if (!answerMatch || !answerMatch[1] || answerMatch[1].length < 2) {
      answerMatch = html.match(/LinkedIn Pinpoint \d+ Answer[^:]*:\s*([^<]{3,100})/i);
    }

    if (answerMatch && answerMatch[1]) {
      data.answer = answerMatch[1].trim()
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, ' ')
        .replace(/\\r/g, '')
        .replace(/\\t/g, ' ')
        .replace(/\\f/g, '')
        .replace(/\\b/g, '')
        .replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
        .substring(0, 300);

      data.answer = decodeHTMLEntities(data.answer);
    }

    // Extract other_solutions from RSC flight data
    const solutions = extractSolutionsFromRSC(html);
    if (solutions.length > 0) {
      data.other_solutions = solutions;
      console.log(`Extracted ${solutions.length} other_solutions from RSC data`);
    }

  } catch (error) {
    console.error('Error extracting data:', error);
  }

  return data;
}

/**
 * Extract other_solutions from Next.js RSC flight data in HTML
 * Looks for patterns in self.__next_f.push calls
 */
function extractSolutionsFromRSC(html) {
  const solutions = [];

  try {
    // Strategy 1: Look for "other_solutions" or "otherSolutions" key in RSC data
    // Pattern: "other_solutions":["word1","word2",...] or "otherSolutions":["word1","word2",...]
    const otherSolutionsPatterns = [
      /\\"other_solutions\\":\s*\\\[([^\]]*?)\\\]/g,
      /\\"otherSolutions\\":\s*\\\[([^\]]*?)\\\]/g,
      /"other_solutions"\s*:\s*\[([^\]]*?)\]/g,
      /"otherSolutions"\s*:\s*\[([^\]]*?)\]/g,
    ];

    for (const pattern of otherSolutionsPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        try {
          const rawArray = '[' + match[1]
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\') + ']';
          const parsed = JSON.parse(rawArray);
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
            solutions.push(...parsed);
          }
        } catch (e) {
          // Parse failed, try next
        }
      }
      if (solutions.length > 0) break;
    }

    if (solutions.length > 0) return solutions;

    // Strategy 2: Look for large escaped JSON arrays after the answer field
    // In RSC data, solutions often appear as a large array right after the answer
    const answerEscaped = html.match(/\\"answer\\":\\"((?:[^"\\]|\\.)*)\\"/);
    if (answerEscaped) {
      const afterAnswerIdx = html.indexOf(answerEscaped[0]) + answerEscaped[0].length;
      const afterAnswerSection = html.substring(afterAnswerIdx, afterAnswerIdx + 50000);

      // Look for the next large escaped JSON array (100+ items is typical for solutions)
      const largeArrayMatch = afterAnswerSection.match(/\\\[((?:\\"[^\"]*\\"\s*,?\s*){20,})\\\]/);
      if (largeArrayMatch) {
        try {
          const rawArray = '[' + largeArrayMatch[1]
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\') + ']';
          const parsed = JSON.parse(rawArray);
          if (Array.isArray(parsed) && parsed.length >= 20 && typeof parsed[0] === 'string') {
            // Validate: these should be reasonable-length words/phrases, not code identifiers
            const validEntries = parsed.filter(s => typeof s === 'string' && s.length > 1 && s.length < 100 && !s.startsWith('static/'));
            if (validEntries.length >= 20) {
              solutions.push(...validEntries);
            }
          }
        } catch (e) {
          // Parse failed
        }
      }
    }

    if (solutions.length > 0) return solutions;

    // Strategy 3: Look for "solutions" key in RSC data that contains an array
    const solutionsKeyPatterns = [
      /\\"solutions\\":\s*\\\[([^\]]*?)\\\]/g,
      /"solutions"\s*:\s*\[([^\]]*?)\]/g,
    ];

    for (const pattern of solutionsKeyPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        try {
          const rawArray = '[' + match[1]
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\') + ']';
          const parsed = JSON.parse(rawArray);
          if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string' && parsed.length >= 5) {
            const validEntries = parsed.filter(s => typeof s === 'string' && s.length > 1 && s.length < 100 && !s.startsWith('static/'));
            if (validEntries.length >= 5) {
              solutions.push(...validEntries);
            }
          }
        } catch (e) {
          // Parse failed
        }
      }
      if (solutions.length > 0) break;
    }

  } catch (error) {
    console.error('Error extracting solutions from RSC:', error);
  }

  return solutions;
}

/**
 * Extract solutions from competitor page (linkedinpinpointanswer.today)
 * The competitor site may show solutions as tag chips on the page
 */
async function extractSolutionsFromCompetitor(number) {
  const competitorUrl = `https://www.linkedinpinpointanswer.today/linkedin-pinpoint-answer/pinpoint-${number}/`;
  console.log(`Trying competitor site for solutions: ${competitorUrl}`);

  try {
    const response = await fetch(competitorUrl, {
      headers: {
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });

    if (!response.ok) {
      console.log(`Competitor site returned ${response.status}`);
      return [];
    }

    const html = await response.text();

    // First, try extracting from RSC data (same as source page)
    const rscSolutions = extractSolutionsFromRSC(html);
    if (rscSolutions.length > 0) {
      console.log(`Found ${rscSolutions.length} solutions from competitor RSC data`);
      return rscSolutions;
    }

    // Look for tag chips / word tags that represent solutions
    // Competitor sites often show solutions as clickable tags or pills
    const solutions = [];

    // Pattern 1: Elements with class containing 'tag', 'chip', 'pill', or 'badge'
    const tagPatterns = [
      /<[^>]*class="[^"]*(?:tag|chip|pill|badge|solution)[^"]*"[^>]*>([^<]+)<\/[^>]+>/gi,
      /<span[^>]*class="[^"]*inline[^"]*"[^>]*>([^<]{2,50})<\/span>/gi,
    ];

    for (const pattern of tagPatterns) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const text = match[1].trim();
        if (text && text.length > 1 && text.length < 100 && !text.match(/^[#\d<]/)) {
          solutions.push(decodeHTMLEntities(text));
        }
      }
    }

    if (solutions.length >= 10) {
      console.log(`Found ${solutions.length} solution tags from competitor site`);
      return solutions;
    }

    console.log(`No significant solutions found on competitor site (found ${solutions.length} tags)`);
    return [];
  } catch (error) {
    console.error('Error fetching competitor site:', error.message);
    return [];
  }
}

/**
 * Generate alternative valid solutions using Gemini API
 * Asks Gemini to produce all valid category answers the game would accept
 */
async function generateSolutions(clues, answer, env) {
  const apiKeyString = env.GEMINI_API_KEY;
  if (!apiKeyString) {
    console.log('GEMINI_API_KEY not set, skipping solution generation');
    return [];
  }

  const apiKeys = apiKeyString.split(',').map(k => k.trim()).filter(k => k.length > 0);
  if (apiKeys.length === 0) return [];

  const prompt = `You are an expert at the LinkedIn Pinpoint game. In this game, players see 5 clues and must guess the category that connects all clues. The game accepts multiple valid category names as correct answers.

Clues: ${clues.join(', ')}
Official Answer: ${answer}

Generate a comprehensive JSON array of ALL valid alternative category answers that the LinkedIn Pinpoint game would accept for this puzzle. Include:
1. Variations of the official answer (singular/plural, synonyms, rephrasings)
2. Broader categories that still accurately describe all clues
3. More specific subcategories if applicable
4. Common ways people would naturally phrase this category

Rules:
- Each entry must be a string that accurately describes ALL 5 clues
- Include the official answer itself as the first element
- Entries should be 2-80 characters long
- Generate at least 30 entries, aim for 50-100
- Return ONLY a valid JSON array of strings, no other text
- Do not include entries that only describe some clues
- Sort by most likely to be accepted by the game (closest to official answer first)

Example output format:
["Things found in a chemistry laboratory","Laboratory equipment","Chemistry lab items","Lab supplies",...]`;

  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.3,
      topK: 20,
      topP: 0.8,
      maxOutputTokens: 4096,
    }
  };

  let lastError = null;

  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    const keyHint = apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);

    try {
      const response = await fetch(
        `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Gemini API error for solutions (key ${keyHint}): ${response.status}`);
        lastError = new Error(`Gemini API error: ${response.status}`);
        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
          continue;
        } else {
          continue;
        }
      }

      const result = await response.json();

      if (result.candidates && result.candidates[0] && result.candidates[0].content) {
        const text = result.candidates[0].content.parts[0].text;
        // Extract JSON array from the response
        const jsonMatch = text.match(/\[([\s\S]*)\]/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse('[' + jsonMatch[1] + ']');
            if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
              // Filter and clean entries
              const validSolutions = parsed
                .filter(s => typeof s === 'string' && s.length > 1 && s.length < 200)
                .map(s => s.trim());
              console.log(`Generated ${validSolutions.length} solutions using key ${keyHint}`);
              return validSolutions;
            }
          } catch (parseErr) {
            console.error('Failed to parse solutions JSON:', parseErr.message);
          }
        }
        lastError = new Error('Could not extract JSON array from Gemini response');
      }
    } catch (error) {
      console.error(`Fetch error for solutions (key ${keyHint}):`, error.message);
      lastError = error;
    }
  }

  console.error('All Gemini API keys failed for solution generation:', lastError?.message);
  return [];
}
