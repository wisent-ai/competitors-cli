// Seed list of well-known competitors. Identity data only (id, name, product
// category, domains, tags); no numeric priority and no market-guessing. Ranking
// is supplied by callers or the model, never hardcoded here. Category strings
// mirror COMPETITOR_PRODUCT_CATEGORIES values (kept literal to avoid a cycle).

export const DEFAULT_COMPETITORS = [
  {
    id: 'character_ai',
    name: 'Character.AI',
    productCategory: 'ai_character_chat',
    domains: ['character.ai'],
    tags: ['character_chat', 'ugc_characters', 'mainstream'],
  },
  {
    id: 'replika',
    name: 'Replika',
    productCategory: 'ai_companion',
    domains: ['replika.com'],
    tags: ['companion', 'mobile', 'subscription'],
  },
  {
    id: 'janitor_ai',
    name: 'JanitorAI',
    productCategory: 'ai_character_chat',
    domains: ['janitorai.com'],
    tags: ['character_chat', 'ugc_characters'],
  },
  {
    id: 'candy_ai',
    name: 'Candy AI',
    productCategory: 'adult_ai_companion',
    domains: ['candy.ai'],
    tags: ['adult', 'companion', 'subscription'],
  },
  {
    id: 'crushon_ai',
    name: 'CrushOn.AI',
    productCategory: 'adult_ai_companion',
    domains: ['crushon.ai'],
    tags: ['adult', 'character_chat'],
  },
  {
    id: 'spicychat',
    name: 'SpicyChat',
    productCategory: 'adult_ai_companion',
    domains: ['spicychat.ai'],
    tags: ['adult', 'character_chat'],
  },
  {
    id: 'nomi',
    name: 'Nomi',
    productCategory: 'ai_companion',
    domains: ['nomi.ai'],
    tags: ['companion', 'relationship'],
  },
  {
    id: 'kindroid',
    name: 'Kindroid',
    productCategory: 'ai_companion',
    domains: ['kindroid.ai'],
    tags: ['companion', 'mobile'],
  },
  {
    id: 'chai',
    name: 'Chai',
    productCategory: 'ai_character_chat',
    domains: ['chai-research.com'],
    tags: ['character_chat', 'mobile'],
  },
  {
    id: 'polybuzz',
    name: 'PolyBuzz',
    productCategory: 'ai_character_chat',
    domains: ['polybuzz.ai'],
    tags: ['character_chat', 'mobile'],
  },
];
