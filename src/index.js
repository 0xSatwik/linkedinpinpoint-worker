/**
 * Cloudflare Worker for LinkedIn Pinpoint Data Scraping and Storage
 * Uses D1 database to store and retrieve pinpoint data
 * Integrates Google Gemini API for generating answer explanations
 */

// GEMINI_API_KEY should be set via `npx wrangler secret put GEMINI_API_KEY`
const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Allowed Origins for Protected Endpoints
const ALLOWED_ORIGINS = [
  'https://pinpointanswertoday.online',
  'https://www.pinpointanswertoday.online',
  'https://pinpointanswers.vercel.app',
  'http://localhost:3001',
  'http://localhost:3000'
];

export default {

  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;
    const origin = request.headers.get('Origin');

    // Check for Secret Key Bypass (Browser Access)
    // Allows accessing protected paths via /path/to/resource/{SECRET_KEY}
    let isAuthorizedBySecret = false;
    const secretKey = env.SECRET_KEY;

    if (secretKey && path.endsWith(`/${secretKey}`)) {
      isAuthorizedBySecret = true;
      // Strip the secret key from the path to allow normal routing
      path = path.substring(0, path.length - (secretKey.length + 1));
      // Handle edge case where path might be empty after strip (e.g. /secret -> /)
      if (path === '') path = '/';
    }

    // CORS headers - Dynamic based on Origin
    let corsHeaders = {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    const isAllowedOrigin = (origin && ALLOWED_ORIGINS.includes(origin)) || isAuthorizedBySecret;

    if (isAllowedOrigin) {
      // If authorized by secret (direct browser), allow * or current origin
      corsHeaders['Access-Control-Allow-Origin'] = origin || '*';
      corsHeaders['Vary'] = 'Origin';
    } else {
      // For unauthorized origins, we might return * or null, or not set it.
      // But since we are going to block protected paths anyway, we can set * for public paths
      // or just leave it strict. Let's set it to null or omit if not allowed.
      // To prevent 'CORS error' hiding the real 403, it's sometimes better to return * but send 403.
      // But user wants strict restriction.
      // If we don't send ACAO, browser blocks it. Logic holds.
    }

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      // If origin is allowed, return success
      if (isAllowedOrigin) {
        return new Response(null, { headers: corsHeaders });
      }
      // If not allowed, we can still return 204 but without ACAO header, which fails CORS check in browser
      return new Response(null, { status: 204 });
    }

    // Protected Endpoints List
    // These endpoints require a valid Origin from the whitelist OR the secret key
    const protectedPrefixes = ['/today', '/yesterday', '/last', '/search'];
    const isProtectedPath = protectedPrefixes.some(prefix => path.startsWith(prefix));

    if (isProtectedPath) {
      if (!isAllowedOrigin) {
        // Direct open (no origin) OR unauthorized origin
        return new Response(JSON.stringify({
          success: false,
          error: 'Forbidden',
          message: 'Protected: Access Denied. Requests allowed only from authorized domains.'
        }), {
          status: 403,
          headers: {
            'Content-Type': 'application/json'
          }
        });
      }
    } else {
      // For non-protected paths (like root), allow * if we want them public,
      // or stick to the strict CORS.
      // User said "show protected only for these".
      // So root / is technically public? 
      // Let's allow * for root if origin is missing/different, to keep API doc visible?
      // Or just keep the strict logic above. 
      // If I want root to be visible to everyone:
      if (!corsHeaders['Access-Control-Allow-Origin']) {
        corsHeaders['Access-Control-Allow-Origin'] = '*';
      }
    }

    try {
      // Root endpoint - API documentation
      if (path === '/') {
        return new Response(JSON.stringify({
          message: 'LinkedIn Pinpoint API',
          version: '1.0.0',
          access: 'Protected Enpoints: /today, /yesterday, /last, /search',
          endpoints: {
            'GET /': 'API documentation',
            'GET /today': 'Get the latest pinpoint data (Protected)',
            'GET /yesterday': 'Get the 2nd latest pinpoint data (Protected)',
            'GET /last/{limit}/{page}': 'Get latest X pinpoints (Protected)',
            'GET /search/clue?q={query}': 'Search by clue text (Protected)',
            'GET /search/answer?q={query}': 'Search by answer text (Protected)',
            'GET /search/number/{number}': 'Get data by pinpoint number (Protected)',
            'GET /search/date/{date}': 'Get data by date (Protected)',
          }
        }, null, 2), {
          headers: corsHeaders,
        });
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
          }), {
            status: 404,
            headers: corsHeaders,
          });
        }

        return new Response(JSON.stringify({
          success: true,
          data: {
            number: result.number,
            date: result.date,
            clues: JSON.parse(result.clues),
            answer: result.answer,
            explanation: result.explanation || null,
            // OPTIMIZATION: Return only top 10 solutions initially
            solutions: result.other_solutions ? JSON.parse(result.other_solutions).slice(0, 10) : [],
            totalSolutions: result.other_solutions ? JSON.parse(result.other_solutions).length : 0,
            created_at: result.created_at,
          }
        }), {
          headers: corsHeaders,
        });
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
          }), {
            status: 404,
            headers: corsHeaders,
          });
        }

        return new Response(JSON.stringify({
          success: true,
          data: {
            number: result.number,
            date: result.date,
            clues: JSON.parse(result.clues),
            answer: result.answer,
            explanation: result.explanation || null,
            // OPTIMIZATION: Return only top 10 solutions initially
            solutions: result.other_solutions ? JSON.parse(result.other_solutions).slice(0, 10) : [],
            totalSolutions: result.other_solutions ? JSON.parse(result.other_solutions).length : 0,
            created_at: result.created_at,
          }
        }), {
          headers: corsHeaders,
        });
      }

      // GET /last/{limit}/{page} - Get latest N pinpoints with pagination
      const lastMatch = path.match(/^\/last\/(\d+)\/(\d+)$/);
      if (lastMatch) {
        let limit = parseInt(lastMatch[1]);
        const page = parseInt(lastMatch[2]);

        if (limit > 20) limit = 20; // Enforce max 20 limit
        if (limit < 1) limit = 1;
        if (page < 1) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Invalid parameter',
            message: 'Page number must be at least 1'
          }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const offset = (page - 1) * limit;

        const results = await env.DB.prepare(
          'SELECT number, date, clues FROM pinpoint_data ORDER BY number DESC LIMIT ? OFFSET ?'
        ).bind(limit, offset).all();

        return new Response(JSON.stringify({
          success: true,
          limit,
          page,
          count: results.results.length,
          data: results.results.map(r => ({
            number: r.number,
            date: r.date,
            clues: JSON.parse(r.clues)
          }))
        }), {
          headers: corsHeaders,
        });
      }

      // 3. GET /solutions/:number/:offset/:limit - Returns batch of solutions
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
            success: true,
            data: slicedSolutions,
            total: allSolutions.length,
            hasMore: (offset + limit) < allSolutions.length
          }), {
            headers: corsHeaders
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { headers: corsHeaders, status: 500 });
        }
      }

      // 9. GET /check/:number/:word - Check if a word is a valid solution for a puzzle
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

          // Case-insensitive check
          const cleanWord = word.toLowerCase().replace(/[^a-z0-9]/g, '');
          const exists = allSolutions.some(s => s.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanWord);

          return new Response(JSON.stringify({
            success: true,
            exists: exists,
            word: word
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), { headers: corsHeaders });
        }
      }

      // GET /add/{number}/{secretkey} - Scrape and add data
      const addMatch = path.match(/^\/add\/(\d+)(?:\/(.+))?$/);
      if (addMatch) {
        const [, number, providedKey] = addMatch;

        // Verify secret key (either in path or via bypass)
        if (providedKey !== env.SECRET_KEY && !isAuthorizedBySecret) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid or missing secret key'
          }), {
            status: 401,
            headers: corsHeaders,
          });
        }

        try {
          const data = await scrapeAndStorePinpoint(env, parseInt(number));

          if (!data || !data.answer) {
            return new Response(JSON.stringify({
              success: false,
              error: 'Processing failed',
              message: 'Could not extract required data',
              data: data
            }), {
              status: 500,
              headers: corsHeaders,
            });
          }

          return new Response(JSON.stringify({
            success: true,
            message: 'Data added/updated successfully',
            data: data
          }), {
            headers: corsHeaders,
          });
        } catch (err) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Failed to add',
            message: err.message
          }), {
            status: 500,
            headers: corsHeaders,
          });
        }
      }

      // GET /delete/{number}/{secretkey} - Delete data
      const deleteMatch = path.match(/^\/delete\/(\d+)(?:\/(.+))?$/);
      if (deleteMatch) {
        const [, number, providedKey] = deleteMatch;

        // Verify secret key (either in path or via bypass)
        if (providedKey !== env.SECRET_KEY && !isAuthorizedBySecret) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Unauthorized',
            message: 'Invalid or missing secret key'
          }), {
            status: 401,
            headers: corsHeaders,
          });
        }

        const result = await env.DB.prepare(
          'DELETE FROM pinpoint_data WHERE number = ?'
        ).bind(parseInt(number)).run();

        if (result.meta.changes === 0) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Not found',
            message: `No data found for pinpoint number ${number}`
          }), {
            status: 404,
            headers: corsHeaders,
          });
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Pinpoint ${number} deleted successfully`
        }), {
          headers: corsHeaders,
        });
      }

      // GET /search/clue?q={query}
      if (path === '/search/clue') {
        const query = url.searchParams.get('q');
        if (!query) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Missing parameter',
            message: 'Query parameter "q" is required'
          }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const results = await env.DB.prepare(
          'SELECT * FROM pinpoint_data WHERE clues LIKE ? ORDER BY number DESC'
        ).bind(`%${query}%`).all();

        return new Response(JSON.stringify({
          success: true,
          count: results.results.length,
          data: results.results.map(r => ({
            number: r.number,
            date: r.date,
            clues: JSON.parse(r.clues),
            answer: r.answer,
            explanation: r.explanation || null,
          }))
        }), {
          headers: corsHeaders,
        });
      }

      // GET /search/answer?q={query}
      if (path === '/search/answer') {
        const query = url.searchParams.get('q');
        if (!query) {
          return new Response(JSON.stringify({
            success: false,
            error: 'Missing parameter',
            message: 'Query parameter "q" is required'
          }), {
            status: 400,
            headers: corsHeaders,
          });
        }

        const results = await env.DB.prepare(
          'SELECT * FROM pinpoint_data WHERE answer LIKE ? ORDER BY number DESC'
        ).bind(`%${query}%`).all();

        return new Response(JSON.stringify({
          success: true,
          count: results.results.length,
          data: results.results.map(r => ({
            number: r.number,
            date: r.date,
            clues: JSON.parse(r.clues),
            answer: r.answer,
            explanation: r.explanation || null,
          }))
        }), {
          headers: corsHeaders,
        });
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
            success: false,
            error: 'Not found',
            message: `No data found for pinpoint number ${number}`
          }), {
            status: 404,
            headers: corsHeaders,
          });
        }

        return new Response(JSON.stringify({
          success: true,
          data: {
            number: result.number,
            date: result.date,
            clues: JSON.parse(result.clues),
            answer: result.answer,
            explanation: result.explanation || null,
            // OPTIMIZATION: Return only top 10 solutions initially
            solutions: result.other_solutions ? JSON.parse(result.other_solutions).slice(0, 10) : [],
            totalSolutions: result.other_solutions ? JSON.parse(result.other_solutions).length : 0,
          }
        }), {
          headers: corsHeaders,
        });
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
            success: false,
            error: 'Not found',
            message: `No data found for date ${date}`
          }), {
            status: 404,
            headers: corsHeaders,
          });
        }

        return new Response(JSON.stringify({
          success: true,
          data: {
            number: result.number,
            date: result.date,
            clues: JSON.parse(result.clues),
            answer: result.answer,
            explanation: result.explanation || null,
            // OPTIMIZATION: Return only top 10 solutions initially
            solutions: result.other_solutions ? JSON.parse(result.other_solutions).slice(0, 10) : [],
            totalSolutions: result.other_solutions ? JSON.parse(result.other_solutions).length : 0,
          }
        }), {
          headers: corsHeaders,
        });
      }

      // 404 - Not found
      return new Response(JSON.stringify({
        success: false,
        error: 'Not found',
        message: 'Endpoint not found',
        availableEndpoints: [
          'GET /',
          'GET /today',
          'GET /add/{number}/{secretkey}',
          'GET /delete/{number}/{secretkey}',
          'GET /search/clue?q={query}',
          'GET /search/answer?q={query}',
          'GET /search/number/{number}',
          'GET /search/date/{date}',
        ]
      }), {
        status: 404,
        headers: corsHeaders,
      });

    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Internal server error',
        message: error.message
      }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};

/**
 * Generate explanation for pinpoint answer using Gemini API
 */
async function generateExplanation(clues, answer, env) {
  const apiKeyString = env.GEMINI_API_KEY;
  if (!apiKeyString) {
    console.error('GEMINI_API_KEY not set, skipping explanation generation');
    return null;
  }

  // Split and trim the keys (supports single key or comma-separated list)
  const apiKeys = apiKeyString.split(',').map(k => k.trim()).filter(k => k.length > 0);

  if (apiKeys.length === 0) {
    console.error('No valid Gemini API keys found in GEMINI_API_KEY');
    return null;
  }

  console.log(`Starting generation with load balancing across ${apiKeys.length} keys`);

  const prompt = `You are a world-class educational analyst specializing in the LinkedIn Pinpoint game. Your goal is to provide a comprehensive, ultra-detailed, and human-like explanation for today's puzzle. 

IMPORTANT: You MUST follow this exact structure. Do not use horizontal rules (*** or ---). Be extremely thorough and write in a normal daily talking way like a real human don't use very hard words for explanations, "article-deep-dive" tone.

Clues:
${clues.map((clue, i) => `${i + 1}. ${clue}`).join('\n')}

Answer: ${answer}

## Deep Clue Analysis
For each clue, provide a pairing of its just  meaning
### ${clues[0]}
**The Meaning of the Clue**: [just meaning of it  "${clues[0]}"]

### ${clues[1]}
**The Meaning of the Clue**: [just meaning of it  "${clues[1]}"]

### ${clues[2]}
**The Meaning of the Clue**: [just meaning of it  "${clues[2]}"]


### ${clues[3]}
**The Meaning of the Clue**: [just meaning of it  "${clues[3]}"]

### ${clues[4]}
**The Meaning of the Clue**: [just meaning of it  "${clues[4]}"]

## How we solved it based on the clues 
write in details how you solved it based on the clues i mean assume yourself as a expert solver and you are soving you got first clue what you though then you got may be wrong answer after submitting and you see the 2nd clue and assume another answer this way explain it and at last you guess the correct answer based on all the clues . and make sure to write in multiple small paragraphs not in sigle big paragraph 


## Lessons Learned from this pinpoint
provide 3-4 pointwise lessons that one learnt and how it can be applied for future puzzles
## Frequently Asked Questions
Provide 4-5 high-quality questions like faqs based on the whole this pinpoint puzzle Format exactly as:
**Q: [In-depth Question]**
**A: [Comprehensive, informative Answer]**

Maintain a premium, expert tone throughout. Ensure every section is fully populated and detailed.`;

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

  // Try each API key until one works
  for (let i = 0; i < apiKeys.length; i++) {
    const apiKey = apiKeys[i];
    const keyHint = apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);

    console.log(`[Attempt ${i + 1}/${apiKeys.length}] Using key: ${keyHint}`);

    try {
      const response = await fetch(
        `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody)
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Gemini API error for key ${keyHint}: ${response.status} - ${errorText}`);
        lastError = new Error(`Gemini API error: ${response.status} - ${errorText}`);

        // If it's a rate limit (429) or server error (5xx), try the next key
        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
          console.warn(`Key ${keyHint} might be rate-limited or unstable, trying next key...`);
          continue;
        } else {
          // For other errors (401, 400), don't bother retrying if it's the only key or if we've tried all
          // actually, let's keep trying other keys just in case one is valid and others aren't
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

  // If we get here, all keys failed
  console.error('All Gemini API keys failed.');
  throw lastError || new Error('All Gemini API keys failed to generate a response.');
}

/**
 * Helper to scrape and store pinpoint data
 */
async function scrapeAndStorePinpoint(env, number) {
  // Scrape data from pinpointanswer.today

  // Add timestamp and headers to bust cache
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

  // Extract data from HTML
  const data = extractPinpointData(html, number);

  if (!data.clues || !data.answer || !data.date) {
    console.log('Incomplete data extracted:', data);
    return data; // Return partial data, caller handles error
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

  // Store in database (upsert)
  await env.DB.prepare(`
    INSERT INTO pinpoint_data (number, date, clues, answer, explanation, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(number) 
    DO UPDATE SET 
      date = excluded.date,
      clues = excluded.clues,
      answer = excluded.answer,
      explanation = excluded.explanation,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    parseInt(number),
    data.date,
    JSON.stringify(data.clues),
    data.answer,
    explanation
  ).run();

  return data;
}

/**
 * Decode HTML entities (e.g., &#x27; to ')
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
    date: ''
  };

  try {
    // Extract date from meta tag or time element
    const dateMatch = html.match(/<time[^>]*datetime="([^"]+)"/i);
    if (dateMatch) {
      data.date = dateMatch[1].split('T')[0]; // Get YYYY-MM-DD part
    }

    // Extract clues from data-clue-card elements
    const clueRegex = /<div[^>]*data-clue-card="true"[^>]*>[\s\S]*?<div[^>]*>([^<]+)<\/div>\s*<\/div>/g;
    let match;
    const clues = [];

    while ((match = clueRegex.exec(html)) !== null) {
      const clueText = match[1].trim();
      if (clueText && !clueText.startsWith('#')) {
        clues.push(clueText);
      }
    }

    // If regex didn't work, try alternative method
    if (clues.length === 0) {
      // Look for clues in a different pattern
      const altClueRegex = /<div[^>]*class="[^"]*cursor-pointer[^"]*"[^>]*>[\s\S]*?<\/div>\s*<div[^>]*>([^<]+)<\/div>/g;
      while ((match = altClueRegex.exec(html)) !== null) {
        const clueText = match[1].trim();
        if (clueText && !clueText.startsWith('#') && clueText.length < 50) {
          clues.push(clueText);
        }
      }
    }

    // Decode HTML entities in clues (e.g., &#x27; to ')
    data.clues = clues.map(clue => decodeHTMLEntities(clue));

    // Extract answer from Next.js JSON data in script tags
    // The answer appears as \\"answer\\":\\"Words that come after 'head'\\",\\"pageData\\" in the React component data
    // The key is to stop at \\" followed by a comma

    // Pattern 1: Match until \\" followed by comma (the pageData boundary)
    // This captures: \\"answer\\":\\"ANSWER_TEXT\\",
    let answerMatch = html.match(/\\"answer\\":\\"([^]*?)\\",/);

    // Pattern 2: Try without the comma boundary in case structure differs
    if (!answerMatch || !answerMatch[1] || answerMatch[1].length < 2) {
      answerMatch = html.match(/\\"answer\\":\\"((?:[^"\\]|\\.)*)\\"/);
    }

    // Pattern 3: Try unescaped JSON pattern  
    if (!answerMatch || !answerMatch[1] || answerMatch[1].length < 2) {
      answerMatch = html.match(/"answer"\s*:\s*"([^"]+)"/);
    }

    // Pattern 4: Try HTML patterns as fallback
    if (!answerMatch || !answerMatch[1] || answerMatch[1].length < 2) {
      answerMatch = html.match(/LinkedIn Pinpoint \d+ Answer[^:]*:\s*([^<]{3,100})/i);
    }

    if (answerMatch && answerMatch[1]) {
      data.answer = answerMatch[1].trim()
        .replace(/\\'/g, "'")     // Unescape single quotes
        .replace(/\\"/g, '"')     // Unescape double quotes
        .replace(/\\\\/g, '\\')   // Unescape backslashes
        .replace(/\\n/g, ' ')     // Replace newlines with spaces
        .replace(/\\r/g, '')      // Remove carriage returns
        .replace(/\\t/g, ' ')     // Replace tabs with spaces
        .replace(/\\f/g, '')      // Remove form feeds
        .replace(/\\b/g, '')      // Remove backspaces
        .replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16))) // Unicode escapes
        .substring(0, 300);       // Safety limit to 300 chars

      // Decode any HTML entities in the answer as well
      data.answer = decodeHTMLEntities(data.answer);
    }

  } catch (error) {
    console.error('Error extracting data:', error);
  }

  return data;
}
