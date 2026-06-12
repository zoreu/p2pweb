/**
 * P2P Web - Utilitários de rede e reescrita de caminhos estáticos
 */

// Decodifica string base64 para texto UTF-8 de forma segura
export function decodeBase64ToUtf8(base64: string): string {
  try {
    let cleanBase64 = base64;
    if (base64.includes(',')) {
      cleanBase64 = base64.split(',')[1];
    } else {
      cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
    }
    const binaryString = atob(cleanBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(bytes);
  } catch (e) {
    console.error('Erro ao decodificar base64:', e);
    return base64;
  }
}

// Verifica se a extensão é bloqueada de acordo com as regras originais
const BLOCKED_EXTENSIONS = ['.mp4', '.mkv', '.mp3', '.avi', '.mov', '.wmv', '.flv', '.webm'];
export function isMediaFile(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return BLOCKED_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
}

// Resolve caminhos relativos em relação ao caminho atual
export function resolveRelativePath(basePath: string, relativePath: string): string | null {
  if (!relativePath) return null;
  
  // Ignora links absolutos e esquemas de dados
  if (
    relativePath.startsWith('http://') || 
    relativePath.startsWith('https://') || 
    relativePath.startsWith('data:') || 
    relativePath.startsWith('//') ||
    relativePath.startsWith('javascript:') ||
    relativePath.startsWith('#')
  ) {
    return null;
  }
  
  let path = relativePath;
  
  // Remove partes de query string ou hash temporariamente para processar
  const queryIndex = path.indexOf('?');
  const hashIndex = path.indexOf('#');
  let cleanPath = path;
  let suffix = '';
  
  if (queryIndex !== -1 && (hashIndex === -1 || queryIndex < hashIndex)) {
    cleanPath = path.substring(0, queryIndex);
    suffix = path.substring(queryIndex);
  } else if (hashIndex !== -1) {
    cleanPath = path.substring(0, hashIndex);
    suffix = path.substring(hashIndex);
  }

  if (!cleanPath) return null;

  // Monta as partes do diretório base
  let basePathParts = basePath.split('/').filter(Boolean);
  if (!basePath.endsWith('/')) {
    // Se o diretório base não termina com barra, assumimos o último elemento como arquivo e tiramos
    basePathParts.pop();
  }

  const relParts = cleanPath.split('/');
  for (const part of relParts) {
    if (part === '.' || part === '') {
      continue;
    }
    if (part === '..') {
      basePathParts.pop();
    } else {
      basePathParts.push(part);
    }
  }

  return '/' + basePathParts.join('/') + suffix;
}

// Intercepta o HTML e baixa todos os recursos estáticos dele via P2P
export async function prepareHtmlAndResources(
  htmlContent: string,
  domain: string,
  currentPath: string,
  conn: any,
  fetchResource: (conn: any, domain: string, path: string) => Promise<any>
): Promise<string> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  
  if (!conn) {
    return htmlContent;
  }

  // Coleta as tags de recursos de interesse
  const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"], link[type="text/css"]'));
  const scripts = Array.from(doc.querySelectorAll('script[src]'));
  const images = Array.from(doc.querySelectorAll('img[src]'));

  // 1. Processar links de CSS auxiliados por Peer P2P
  const cssPromises = links.map(async (link) => {
    const rawHref = link.getAttribute('href');
    if (!rawHref) return;

    const resolved = resolveRelativePath(currentPath, rawHref);
    if (!resolved) return;

    const proxyUrl = `/p2p-proxy/${domain}${resolved}`;

    try {
      console.log(`📥 [P2P-RECURSO] Baixando CSS: ${resolved}`);
      const responseData = await fetchResource(conn, domain, resolved);
      const isSuccess = responseData && (responseData.status === undefined || (responseData.status >= 200 && responseData.status < 300));
      if (isSuccess && responseData.body) {
        let cssText = responseData.body;
        if (typeof cssText === 'string' && cssText.startsWith('data:')) {
          cssText = decodeBase64ToUtf8(cssText);
        }
        
        const styleEl = doc.createElement('style');
        styleEl.textContent = cssText;
        if (link.id) styleEl.id = link.id;
        
        // Substitui a tag link externa por estilos injetados localmente
        link.parentNode?.replaceChild(styleEl, link);
      } else {
        // Se o download falhar, reescreve o href para o Service Worker proxy de fallback
        link.setAttribute('href', proxyUrl);
      }
    } catch (err) {
      console.error(`Erro ao obter recurso CSS ${resolved}:`, err);
      // Fallback para o Proxy se der erro
      link.setAttribute('href', proxyUrl);
    }
  });

  // 2. Processar scripts JS auxiliados por Peer P2P
  const jsPromises = scripts.map(async (script) => {
    const rawSrc = script.getAttribute('src');
    if (!rawSrc) return;

    const resolved = resolveRelativePath(currentPath, rawSrc);
    if (!resolved) return;

    const proxyUrl = `/p2p-proxy/${domain}${resolved}`;

    try {
      console.log(`📥 [P2P-RECURSO] Baixando JS: ${resolved}`);
      const responseData = await fetchResource(conn, domain, resolved);
      const isSuccess = responseData && (responseData.status === undefined || (responseData.status >= 200 && responseData.status < 300));
      if (isSuccess && responseData.body) {
        let jsText = responseData.body;
        if (typeof jsText === 'string' && jsText.startsWith('data:')) {
          jsText = decodeBase64ToUtf8(jsText);
        }
        
        const inlineScript = doc.createElement('script');
        inlineScript.textContent = jsText;
        if (script.id) inlineScript.id = script.id;
        
        // Substitui a chamada JS por script injetado localmente
        script.parentNode?.replaceChild(inlineScript, script);
      } else {
        // Se o download falhar, reescreve o src para o Service Worker proxy de fallback
        script.setAttribute('src', proxyUrl);
      }
    } catch (err) {
      console.error(`Erro ao obter recurso JS ${resolved}:`, err);
      // Fallback para o Proxy se der erro
      script.setAttribute('src', proxyUrl);
    }
  });

  // 3. Processar imagens auxiliadas por Peer P2P
  const imgPromises = images.map(async (img) => {
    const rawSrc = img.getAttribute('src');
    if (!rawSrc) return;

    const resolved = resolveRelativePath(currentPath, rawSrc);
    if (!resolved) return;

    const proxyUrl = `/p2p-proxy/${domain}${resolved}`;

    try {
      console.log(`📥 [P2P-RECURSO] Baixando Imagem: ${resolved}`);
      const responseData = await fetchResource(conn, domain, resolved);
      const isSuccess = responseData && (responseData.status === undefined || (responseData.status >= 200 && responseData.status < 300));
      if (isSuccess && responseData.body) {
        if (typeof responseData.body === 'string' && responseData.body.startsWith('data:')) {
          img.setAttribute('src', responseData.body);
        } else {
          // Se o body não for uma data URI válida mas o recurso foi carregado de outra forma, usa o proxy de fallback
          img.setAttribute('src', proxyUrl);
        }
      } else {
        // Fallback se o download síncrono falhar
        img.setAttribute('src', proxyUrl);
      }
    } catch (err) {
      console.error(`Erro ao obter recurso de imagem ${resolved}:`, err);
      // Fallback para o Proxy se der erro
      img.setAttribute('src', proxyUrl);
    }
  });

  // Executa todas as buscas em paralelo para acelerar o carregamento do site P2P
  await Promise.all([...cssPromises, ...jsPromises, ...imgPromises]);

  return doc.documentElement.outerHTML;
}
