/**
 * P2P Web - Service Worker Proxy
 * Intercepta solicitações de subrecursos (CSS, JS, Fontes, Imagens, etc.) realizadas por dentro do Iframe
 * e as responde solicitando os dados aos peers ativos da aba principal via postMessage.
 */

const SW_VERSION = 'p2p-proxy-v2';

self.addEventListener('install', (event) => {
  console.log('[SW] Instalado com sucesso.');
  // Força o SW novo a tomar controle imediatamente
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Ativado e controlando clientes.');
  event.waitUntil(self.clients.claim());
});

// Cache e promessas de requisições pendentes de comunicação com a aba principal
const pendingRequests = new Map();

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'P2P_PROXY_RESPONSE') {
    const resolver = pendingRequests.get(data.requestId);
    if (resolver) {
      resolver(data);
      pendingRequests.delete(data.requestId);
    }
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Intercepta apenas requisições que contenham o caminho especial de proxy P2P
  if (url.pathname.includes('/p2p-proxy/')) {
    event.respondWith(handleP2PProxyFetch(event.request, url));
  }
});

async function handleP2PProxyFetch(request, url) {
  // O caminho terá o formato: /p2p-proxy/nome-do-peer/caminho/do/recurso
  const proxyPrefixIndex = url.pathname.indexOf('/p2p-proxy/');
  const pathAfterProxy = url.pathname.substring(proxyPrefixIndex + '/p2p-proxy/'.length);
  
  // Extrai o domínio (nome-do-peer) e o caminho do arquivo no host remoto + querystring
  const pathParts = pathAfterProxy.split('/');
  const peerDomain = pathParts[0];
  const resourcePath = '/' + pathParts.slice(1).join('/') + url.search;

  console.log(`[SW Fetch] Interceptado: Peer=${peerDomain}, Recurso=${resourcePath}, Method=${request.method}`);

  // Encontra as abas abertas da nossa aplicação para enviar a requisição
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  
  if (!clients || clients.length === 0) {
    console.error('[SW Warning] Nenhum cliente ativo encontrado para responder.');
    return new Response('<h1>Conexão P2P indisponível</h1><p>Não há abas ativas do P2P Web abertas para proxy.</p>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // Tenta extrair o corpo se for POST/PUT/PATCH para enviar via postMessage
  let requestBody = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      requestBody = await request.text();
    } catch (err) {
      console.warn('[SW] Falha ao extrair body da requisição:', err);
    }
  }

  const requestId = 'sw_req_' + Date.now() + '_' + Math.random().toString(36).substring(2);

  // Cria uma promessa para aguardar a resposta da aba ativa
  const responsePromise = new Promise((resolve) => {
    pendingRequests.set(requestId, resolve);
    
    // Timeout de segurança
    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        resolve({
          status: 408,
          body: 'data:text/html;base64,PGgxPlRpbWVvdXQgZG8gU2VydmljZSBXb3JrZXI8L2gxPg==', // "<h1>Timeout do Service Worker</h1>"
          contentType: 'text/html'
        });
      }
    }, 25000);
  });

  // Envia a mensagem para todas as abas (a primeira disponível responde)
  // Normalmente há apenas uma aba ativa, mas enviamos para todas para garantir
  clients[0].postMessage({
    type: 'P2P_PROXY_FETCH',
    requestId,
    domain: peerDomain,
    path: resourcePath,
    method: request.method,
    headers: {
      'Accept': request.headers.get('Accept') || '*/*',
      'Cache-Control': request.headers.get('Cache-Control') || 'no-cache',
      'Content-Type': request.headers.get('Content-Type') || request.headers.get('content-type') || ''
    },
    body: requestBody
  });

  const responseData = await responsePromise;
  
  // Reconstrói a Response do navegador real
  try {
    let contentType = responseData.contentType || 'application/octet-stream';
    let bodyData;

    if (responseData.body && typeof responseData.body === 'string' && responseData.body.startsWith('data:')) {
      // Decodifica base64 enviado de volta
      const base64Content = responseData.body.split(',')[1] || responseData.body;
      const binaryString = atob(base64Content);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      bodyData = bytes.buffer;
    } else {
      bodyData = responseData.body || '';
    }

    // Configura os cabeçalhos de resposta HTTP para as fontes, estilos e scripts carregarem livremente
    const responseHeaders = new Headers({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    if (responseData.headers) {
      for (const [key, value] of Object.entries(responseData.headers)) {
        if (key.toLowerCase() !== 'content-type' && key.toLowerCase() !== 'access-control-allow-origin') {
          responseHeaders.set(key, value);
        }
      }
    }

    return new Response(bodyData, {
      status: responseData.status || 200,
      statusText: responseData.statusText || 'OK',
      headers: responseHeaders
    });

  } catch (error) {
    console.error('[SW Error] Falha ao processar resposta do peer:', error);
    return new Response(`<h1>Erro de resposta P2P</h1><p>${error.message}</p>`, {
      status: 502,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}
