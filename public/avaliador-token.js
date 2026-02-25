(function () {
  const TOKEN_KEY = 'avaliador_token';

  function uuidV4Fallback() {
    const bytes = new Uint8Array(16);

    if (window.crypto?.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0'));
    return `${hex.slice(0,4).join('')}-${hex.slice(4,6).join('')}-${hex.slice(6,8).join('')}-${hex.slice(8,10).join('')}-${hex.slice(10,16).join('')}`;
  }

  function getOrCreateToken() {
    let token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      token = (window.crypto?.randomUUID?.() || uuidV4Fallback());
      localStorage.setItem(TOKEN_KEY, token);
    }
    return token;
  }

  function normalizaCarreta(valor) {
    return String(valor || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');
  }

  // expõe para usar no HTML e para testar no console
  window.Avaliador = {
    getToken: getOrCreateToken,
    normalizaCarreta
  };

  document.addEventListener('DOMContentLoaded', () => {
    const t = getOrCreateToken();
    console.log('✅ avaliador_token criado/ok:', t);
  });
})();
