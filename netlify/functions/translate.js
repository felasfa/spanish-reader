const Anthropic = require('@anthropic-ai/sdk');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let word, sentence;
  try {
    ({ word, sentence } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!word) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'word is required' }) };
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are a Spanish-to-English translator. Translate the following:

Spanish word: "${word}"
Spanish sentence: "${sentence || word}"

Respond ONLY with valid JSON in this exact format, no other text:
{
  "wordTranslation": "English translation of the word",
  "sentenceTranslation": "English translation of the sentence"
}`,
      }],
    });

    if (!message.content || !message.content[0] || message.content[0].type !== 'text') {
      throw new Error(`Unexpected API response (stop_reason: ${message.stop_reason || 'unknown'})`);
    }
    const text = message.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Unexpected response from Claude');

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: match[0],
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
