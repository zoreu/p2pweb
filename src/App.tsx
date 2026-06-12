import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Peer, DataConnection } from 'peerjs';
import { 
  Globe, 
  RefreshCw, 
  ArrowLeft, 
  ArrowRight, 
  Trash2, 
  User, 
  Server, 
  AlertTriangle, 
  Loader2, 
  Share2, 
  Copy, 
  Plus, 
  Menu, 
  X,
  CheckCircle,
  HelpCircle,
  Clock
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PublishedSite } from './types';
import { 
  resolveRelativePath,
  isMediaFile
} from './utils/p2pHelpers';

// ID de visitante gerado aleatoriamente
function generateRandomPeerId(): string {
  const arr = new Uint8Array(12);
  crypto.getRandomValues(arr);
  return 'v_' + Array.from(arr).map(b => b.toString(36)).join('');
}

export default function App() {
  // --- ESTADOS GLOBAIS ---
  const [isHost, setIsHost] = useState<boolean>(() => {
    return localStorage.getItem('p2pweb_is_host') === 'true';
  });
  const [myDomain, setMyDomain] = useState<string>(() => {
    return localStorage.getItem('p2pweb_domain') || '';
  });
  const [mySites, setMySites] = useState<PublishedSite[]>(() => {
    try {
      const saved = localStorage.getItem('p2pweb_sites');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  
  // --- NAVEGADOR ESTADO ---
  const [isPeerReady, setIsPeerReady] = useState<boolean>(false);
  const [myPeerId, setMyPeerId] = useState<string>('');
  const [currentDomain, setCurrentDomain] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>('/');
  const [browserInput, setBrowserInput] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  
  // --- HISTÓRICO ---
  const [historyStack, setHistoryStack] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  
  // Form de publicação
  const [publishUrlInput, setPublishUrlInput] = useState<string>('');
  const [registerDomainInput, setRegisterDomainInput] = useState<string>(myDomain);

  // --- REFS ---
  const peerInstance = useRef<Peer | null>(null);
  const activeConnections = useRef<Map<string, DataConnection>>(new Map());
  const pendingRequests = useRef<Map<string, (data: any) => void>>(new Map());
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const mySitesRef = useRef<PublishedSite[]>(mySites);

  // Mantém a lista atualizada para as conexões ativas responderem sempre do local correto
  useEffect(() => {
    mySitesRef.current = mySites;
  }, [mySites]);

  // --- FUNÇÃO AUXILIAR SILENCIOSA PARA BUSCA DE RECURSOS via P2P ---
  const fetchResourceViaP2P = useCallback(async (
    conn: DataConnection, 
    domain: string, 
    path: string,
    method: string = 'GET',
    headers: any = { 'Accept': '*/*' },
    body: any = null
  ): Promise<any> => {
    const requestId = 'req_res_' + Date.now() + '_' + Math.random().toString(36).substring(2);
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingRequests.current.has(requestId)) {
          pendingRequests.current.delete(requestId);
          reject(new Error(`Timeout ao baixar recurso P2P de estilo/script: ${path}`));
        }
      }, 15000); // 15s de timeout para arquivos auxiliares
      
      pendingRequests.current.set(requestId, (data) => {
        clearTimeout(timeout);
        pendingRequests.current.delete(requestId);
        resolve(data);
      });
      
      const responseHandler = (data: any) => {
        if (data.type === 'http-response' && data.requestId === requestId) {
          const handler = pendingRequests.current.get(requestId);
          if (handler) handler(data);
          conn.off('data', responseHandler);
        }
      };
      
      conn.on('data', responseHandler);
      
      conn.send({ 
        type: 'http-request', 
        requestId, 
        path: path, 
        method,
        headers,
        body
      });
    });
  }, []);

  // --- REGISTRO DO SERVICE WORKER E TRATADOR DE MENSAGENS P2P ---
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then((reg) => {
          console.log('[App] Service Worker registrado com sucesso escopo:', reg.scope);
        })
        .catch((err) => {
          console.error('[App] Erro ao registrar Service Worker:', err);
        });
    }

    const handleSWMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (data && data.type === 'P2P_PROXY_FETCH') {
        const { requestId, domain, path, method, headers, body } = data;
        console.log(`[P2P SW Proxy] Interceptado: Domain=${domain}, Path=${path}, Method=${method}`);

        try {
          let responseData;
          const cleanDomain = domain.toLowerCase().trim();

          // Se for próprio site local rodando no Host
          if (isHost && cleanDomain === myDomain) {
            const activeSites = mySitesRef.current;
            if (activeSites.length === 0) {
              throw new Error('Nenhum site local publicado no Host.');
            }
            const site = activeSites[0];
            const fetchUrl = site.url + path;
            const res = await fetch(fetchUrl, {
              method,
              headers: { 'Cache-Control': 'no-cache', ...headers },
              body: method !== 'GET' && method !== 'HEAD' ? body : undefined
            });
            const contentType = res.headers.get('content-type') || 'application/octet-stream';
            const arrayBuffer = await res.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);

            responseData = {
              type: 'P2P_PROXY_RESPONSE',
              requestId,
              status: res.status,
              statusText: res.statusText,
              contentType,
              body: `data:${contentType};base64,${base64}`,
              headers: Object.fromEntries(res.headers.entries())
            };
          } else {
            // Se for um peer remoto
            let conn = activeConnections.current.get(cleanDomain);

            if (!conn || !conn.open) {
              if (peerInstance.current && isPeerReady) {
                conn = peerInstance.current.connect(cleanDomain, { reliable: true });
                const connected = await new Promise<boolean>((resolve) => {
                  const timeout = setTimeout(() => resolve(false), 9000);
                  conn!.on('open', () => {
                    clearTimeout(timeout);
                    activeConnections.current.set(cleanDomain, conn!);
                    resolve(true);
                  });
                  conn!.on('error', () => {
                    clearTimeout(timeout);
                    resolve(false);
                  });
                });
                if (!connected) {
                  throw new Error(`O peer "${cleanDomain}" está offline.`);
                }
              } else {
                throw new Error('Rede P2P indisponível no momento.');
              }
            }

            // Busca via P2P
            const p2pRes = await fetchResourceViaP2P(conn!, cleanDomain, path, method, headers, body);
            responseData = {
              type: 'P2P_PROXY_RESPONSE',
              requestId,
              status: p2pRes.status || 200,
              statusText: p2pRes.statusText || 'OK',
              contentType: p2pRes.headers?.['Content-Type'] || p2pRes.headers?.['content-type'] || 'application/octet-stream',
              body: p2pRes.body,
              headers: p2pRes.headers || {}
            };
          }

          // Envia de volta para o Service Worker
          if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage(responseData);
          } else {
            // Em browsers que o controller ainda não assumiu, tenta a comunicação ativa direta
            const reg = await navigator.serviceWorker.ready;
            if (reg.active) {
              reg.active.postMessage(responseData);
            }
          }
        } catch (err: any) {
          console.error(`[P2P SW Proxy Error] Falha de proxy para ${path}:`, err);
          const errResponse = {
            type: 'P2P_PROXY_RESPONSE',
            requestId,
            status: 404,
            statusText: 'Not Found',
            contentType: 'text/html',
            body: `data:text/html;base64,PGgxPjQwNCAtIEZhbGhhIG5vIFByb3h5IFAyUDwvaDE+PHA+TmFvIGZvaSBwb3NzaXZlbCBvYnRlciBvIHJlY3Vyc286IA==` + btoa(err.message),
            headers: {}
          };
          if (navigator.serviceWorker && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage(errResponse);
          } else {
            const reg = await navigator.serviceWorker.ready;
            if (reg.active) reg.active.postMessage(errResponse);
          }
        }
      }
    };

    navigator.serviceWorker.addEventListener('message', handleSWMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleSWMessage);
    };
  }, [isHost, myDomain, isPeerReady, fetchResourceViaP2P]);

  // Exibe toast por tempo limitado
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 4000);
  }, []);

  // --- PERSISTÊNCIA DE SITES ---
  const saveSitesList = (sites: PublishedSite[]) => {
    localStorage.setItem('p2pweb_sites', JSON.stringify(sites));
    setMySites(sites);
  };

  // --- TRATAMENTO DE REQUISIÇÕES DO HOST (O host atua como proxy) ---
  const handleHttpRequest = useCallback(async (data: any, conn: DataConnection) => {
    const fullPath = data.path;
    const method = data.method || 'GET';
    const requestHeaders = data.headers || {};
    const requestBody = data.body;
    
    // Resposta para OPTIONS (preflight CORS)
    if (method === 'OPTIONS') {
      conn.send({
        type: 'http-response',
        requestId: data.requestId,
        status: 200,
        statusText: 'OK',
        body: '',
        headers: {
          'Content-Type': 'text/plain',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        },
        isBinary: false
      });
      return;
    }
    
    const activeSites = mySitesRef.current;
    if (activeSites.length === 0) {
      conn.send({ 
        type: 'http-response', 
        requestId: data.requestId, 
        status: 404, 
        body: '<h1>404 - Site não publicado no Host</h1> <p>O host detentor deste domínio não programou nenhum site local para este endereço.</p>',
        headers: { 'Content-Type': 'text/html' }
      });
      return;
    }
    
    const site = activeSites[0];
    
    // Aborta arquivos de mídia para preservar banda no P2P
    if (isMediaFile(fullPath)) {
      conn.send({
        type: 'http-response',
        requestId: data.requestId,
        status: 415,
        body: `<h1>Arquivo de mídia rejeitado</h1><p>O arquivo ${fullPath} não pôde ser carregado via rede P2P.</p>`,
        headers: { 'Content-Type': 'text/html' }
      });
      return;
    }
    
    try {
      const targetUrl = site.url + fullPath;
      console.log(`📡 [PROXY HOST] Solicitando recurso local: ${method} ${targetUrl}`);
      
      const fetchOptions: RequestInit = {
        method: method,
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          ...requestHeaders
        }
      };
      
      if (requestBody && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        fetchOptions.body = requestBody;
      }
      
      const response = await fetch(targetUrl, fetchOptions);
      const contentType = response.headers.get('content-type') || 'text/plain';
      
      // Converte o retorno para base64 binário
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);
      const body = `data:${contentType};base64,${base64}`;
      
      conn.send({
        type: 'http-response',
        requestId: data.requestId,
        status: response.status,
        statusText: response.statusText,
        body: body,
        headers: { 
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*'
        },
        isBinary: true
      });
      
    } catch (e: any) {
      console.error('Erro no proxy de foward do host:', e);
      conn.send({ 
        type: 'http-response', 
        requestId: data.requestId, 
        status: 500, 
        body: `<h1>Erro 500 - Falha no Servidor Local</h1><p>${e.message}</p>`,
        headers: { 'Content-Type': 'text/html' }
      });
    }
  }, []);

  // --- INICIALIZADOR PEERJS ---
  const initPeer = useCallback(() => {
    // Limpa peer existente
    if (peerInstance.current) {
      try {
        peerInstance.current.destroy();
      } catch (e) {
        console.error(e);
      }
      peerInstance.current = null;
    }
    
    activeConnections.current.clear();
    pendingRequests.current.clear();
    setIsPeerReady(false);

    let assignedId = '';
    if (isHost && myDomain) {
      assignedId = myDomain; // PeerId é o próprio domínio sem .p2p
    } else {
      assignedId = generateRandomPeerId();
    }
    
    setMyPeerId(assignedId);
    console.log(`Iniciando Peer com ID: ${assignedId}, Modo: ${isHost ? 'HOST' : 'VISITANTE'}`);

    // Cria o objeto Peer com servidores de sinalização públicos confiáveis do Google & Metered TURN
    const newPeer = new Peer(assignedId, {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
          { urls: 'stun:stun4.l.google.com:19302' },
          { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
          { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }          
        ]
      }
    });

    peerInstance.current = newPeer;

    newPeer.on('open', () => {
      setIsPeerReady(true);
      if (isHost && myDomain) {
        showToast(`✅ Servidor P2P Online! Domínio ${myDomain}.p2p ativado.`);
      } else {
        showToast('✅ Navegador P2P conectado à rede dcentralizada.');
      }
    });

    newPeer.on('connection', (conn) => {
      console.log(`📡 Nova conexão P2P recebida de: ${conn.peer}`);
      activeConnections.current.set(conn.peer, conn);

      conn.on('data', async (data: any) => {
        if (data && data.type === 'http-request') {
          await handleHttpRequest(data, conn);
        }
      });

      conn.on('close', () => {
        console.log(`🔌 Conexão fechada com o visitante: ${conn.peer}`);
        activeConnections.current.delete(conn.peer);
      });
    });

    newPeer.on('error', (err) => {
      console.error('PeerJS Error:', err);
      if (err.type === 'unavailable-id') {
        setIsPeerReady(false);
        showToast(`❌ Erro: O domínio "${myDomain}.p2p" já está em uso por outro Host!`);
      } else {
        showToast(`⚠️ Conexão PeerJS: ${err.type}`);
      }
    });

    newPeer.on('disconnected', () => {
      setIsPeerReady(false);
      // Tenta reconectar após alguns segundos
      setTimeout(() => {
        if (peerInstance.current && !peerInstance.current.destroyed) {
          peerInstance.current.reconnect();
        }
      }, 4000);
    });

    return () => {
      newPeer.destroy();
    };
  }, [isHost, myDomain, handleHttpRequest, showToast]);

  // Inicializa o PeerJS quando alteramos as configurações principais
  useEffect(() => {
    initPeer();
    return () => {
      if (peerInstance.current) {
        peerInstance.current.destroy();
      }
    };
  }, [isHost, myDomain]);

  // --- NAVEGAÇÃO INTERNA DO LOCAL E REMOTO ---
  const navigateTo = useCallback(async (domain: string, path: string, isHistoryNavigation: boolean = false) => {
    if (!peerInstance.current || !isPeerReady) {
      showToast('⏳ Aguarde a inicialização da rede P2P local...');
      return;
    }

    const cleanDomain = domain.toLowerCase().trim();
    setCurrentDomain(cleanDomain);
    setCurrentPath(path);
    setBrowserInput(`${cleanDomain}.p2p${path}`);
    setIsLoading(true);
    setLoadError(null);

    // Adiciona ao Histórico se não for navegação traseira/frontal
    if (!isHistoryNavigation) {
      const fullUrl = `${cleanDomain}.p2p${path}`;
      setHistoryStack(prev => {
        const updated = prev.slice(0, historyIndex + 1);
        updated.push(fullUrl);
        return updated;
      });
      setHistoryIndex(prev => prev + 1);
    }

    // Se for o próprio domínio do Host rodando localmente
    if (isHost && cleanDomain === myDomain) {
      if (mySites.length === 0) {
        setLoadError('Domínio registrado, mas nenhum site local foi publicado no painel.');
        setIsLoading(false);
        return;
      }
    } else {
      // Se for um peer remoto
      const targetPeerId = cleanDomain;
      let conn = activeConnections.current.get(targetPeerId);

      if (!conn || !conn.open) {
        try {
          console.log(`🔌 Tentando abrir conexão física P2P para o Host: ${targetPeerId}`);
          conn = peerInstance.current.connect(targetPeerId, { reliable: true });
        } catch (e: any) {
          setLoadError(`Não foi possível estabelecer contato P2P: ${e.message}`);
          setIsLoading(false);
          return;
        }

        const connected = await new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), 9000);
          conn!.on('open', () => {
            clearTimeout(timeout);
            activeConnections.current.set(targetPeerId, conn!);
            resolve(true);
          });
          conn!.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
          });
        });

        if (!connected) {
          setLoadError(`O domínio "${cleanDomain}.p2p" está Offline ou não existe.`);
          setIsLoading(false);
          return;
        }
      }
    }

    // Carrega a URL no iframe através do proxy do Service Worker
    if (iframeRef.current) {
      try {
        if ('serviceWorker' in navigator) {
          await navigator.serviceWorker.ready;
        }
        iframeRef.current.src = `/p2p-proxy/${cleanDomain}${path}`;
      } catch (err: any) {
        console.error("Erro ao carregar URL do proxy no iframe:", err);
        setLoadError(`Erro ao carregar recurso do proxy: ${err.message}`);
        setIsLoading(false);
      }
    }
  }, [isHost, myDomain, mySites, isPeerReady, historyIndex, showToast]);

  const methodText = (m: string) => m;

  // --- ESCUTA OS CARREGAMENTOS E DO IFRAME E SINCRONIZA CORRETAMENTE ---
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const handleLoad = () => {
      setIsLoading(false);
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) return;

        // Configuração de cliques em links relativos
        doc.body.removeEventListener('click', () => {});
        doc.body.addEventListener('click', (e: MouseEvent) => {
          let target = e.target as HTMLElement | null;
          while (target && target.tagName !== 'A') {
            target = target.parentElement;
          }

          if (target && target instanceof HTMLAnchorElement) {
            const href = target.getAttribute('href');
            if (href) {
              // Deixa links externos absolutos ou esquemas especiais navegarem naturalmente
              if (
                href.startsWith('http://') || 
                href.startsWith('https://') || 
                href.startsWith('//') || 
                href.startsWith('data:') ||
                href.startsWith('javascript:') ||
                href.startsWith('#')
              ) {
                return;
              }
              e.preventDefault();

              const resolvedPath = resolveRelativePath(currentPath, href) || (href.startsWith('/') ? href : '/' + href);
              navigateTo(currentDomain || '', resolvedPath);
            }
          }
        });

        // Interceptação de submissão de formulários
        const forms = doc.querySelectorAll('form');
        forms.forEach(form => {
          form.addEventListener('submit', (e) => {
            const method = (form.method || 'GET').toUpperCase();
            if (method === 'GET') {
              e.preventDefault();
              const action = form.getAttribute('action') || '';
              if (
                action.startsWith('http://') || 
                action.startsWith('https://') || 
                action.startsWith('//') || 
                action.startsWith('data:')
              ) {
                return;
              }
              const resolvedPath = resolveRelativePath(currentPath, action) || (action.startsWith('/') ? action : '/' + action);
              const formData = new FormData(form);
              const params = new URLSearchParams(formData as any).toString();
              const finalPath = resolvedPath + (resolvedPath.includes('?') ? '&' : '?') + params;
              navigateTo(currentDomain || '', finalPath);
            } else {
              // Para solicitações POST/PUT/etc, permitimos o envio nativo
              // para que o corpo de dados seja enviado de fato e interceptado pelo SW,
              // mas ativamos o indicador de carregamento
              setIsLoading(true);
            }
          });
        });

        // Sincroniza barra de endereço do navegador principal com iframe
        const loc = iframe.contentWindow?.location;
        if (loc) {
          const pathname = loc.pathname;
          const search = loc.search || '';
          if (pathname.includes('/p2p-proxy/')) {
            const index = pathname.indexOf('/p2p-proxy/');
            const parts = pathname.substring(index + '/p2p-proxy/'.length).split('/');
            const foundDomain = parts[0];
            const foundPath = '/' + parts.slice(1).join('/') + search;
            
            const fullUrl = `${foundDomain}.p2p${foundPath}`;
            
            if (foundDomain && (foundDomain !== currentDomain || foundPath !== currentPath)) {
              setCurrentDomain(foundDomain);
              setCurrentPath(foundPath);
              setBrowserInput(fullUrl);

              setHistoryStack(prev => {
                const currentIndexClean = historyIndex === -1 ? 0 : historyIndex;
                const updated = prev.slice(0, currentIndexClean + 1);
                if (updated[updated.length - 1] === fullUrl) {
                  return prev;
                }
                updated.push(fullUrl);
                return updated;
              });
              setHistoryIndex(prev => {
                const currentIndexClean = prev === -1 ? 0 : prev;
                if (historyStack[currentIndexClean] === fullUrl) {
                  return prev;
                }
                return currentIndexClean + 1;
              });
            }
          }
        }
      } catch (err) {
        console.warn("Impossível sincronizar propriedades do iframe por segurança (CORS):", err);
      }
    };

    iframe.addEventListener('load', handleLoad);
    return () => {
      if (iframe) {
        iframe.removeEventListener('load', handleLoad);
      }
    };
  }, [currentDomain, currentPath, navigateTo, historyIndex, historyStack]);

  // --- VOLTAR / AVANÇAR / REFRESH ---
  const handleGoBack = () => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      setHistoryIndex(prevIndex);
      const url = historyStack[prevIndex];
      const match = url.match(/^([^/]+)(.*)$/);
      if (match) {
        const domain = match[1].replace('.p2p', '');
        const path = match[2] || '/';
        navigateTo(domain, path);
      }
    }
  };

  const handleGoForward = () => {
    if (historyIndex < historyStack.length - 1) {
      const nextIndex = historyIndex + 1;
      setHistoryIndex(nextIndex);
      const url = historyStack[nextIndex];
      const match = url.match(/^([^/]+)(.*)$/);
      if (match) {
        const domain = match[1].replace('.p2p', '');
        const path = match[2] || '/';
        navigateTo(domain, path);
      }
    }
  };

  const handleRefresh = () => {
    if (currentDomain) {
      navigateTo(currentDomain, currentPath);
    }
  };

  const handleGoSubmit = () => {
    let input = browserInput.trim();
    if (!input) return;

    input = input.replace(/^p2p:\/\//, '');

    let domain = '';
    let path = '/';
    const firstSlash = input.indexOf('/');

    if (firstSlash === -1) {
      domain = input;
      path = '/';
    } else {
      domain = input.substring(0, firstSlash);
      path = input.substring(firstSlash);
    }

    if (domain.endsWith('.p2p')) {
      domain = domain.replace('.p2p', '');
    }

    navigateTo(domain, path);
  };

  // --- BOTÕES DE CADASTROS ---
  const handleRegisterDomain = () => {
    const input = registerDomainInput.trim().toLowerCase();
    if (!input || input.length < 3) {
      showToast('❌ O domínio deve conter no mínimo 3 caracteres.');
      return;
    }

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(input)) {
      showToast('❌ Use apenas letras minúsculas, números e hífens.');
      return;
    }

    setMyDomain(input);
    localStorage.setItem('p2pweb_domain', input);
    showToast(`⏳ Ativando domínio ${input}.p2p...`);
  };

  const handlePublishSite = () => {
    const url = publishUrlInput.trim();
    if (!url) {
      showToast('❌ Digite uma URL válida.');
      return;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      showToast('❌ A URL deve começar com http:// ou https://');
      return;
    }

    if (!myDomain) {
      showToast('❌ Ative um domínio primeiro.');
      return;
    }

    const updated = [{ url, createdAt: Date.now() }];
    saveSitesList(updated);
    setPublishUrlInput('');
    showToast(`✅ Servidor local publicado em ${myDomain}.p2p!`);
  };

  const handleRemoveSite = () => {
    saveSitesList([]);
    showToast('🗑️ Site removido do Host.');
  };

  const handleModeToggle = () => {
    const targetState = !isHost;
    setIsHost(targetState);
    localStorage.setItem('p2pweb_is_host', String(targetState));

    if (!targetState) {
      setMyDomain('');
      localStorage.removeItem('p2pweb_domain');
      saveSitesList([]);
    }
    
    // Limpa estado de navegação ao alterar modo
    setCurrentDomain(null);
    setCurrentPath('/');
    setBrowserInput('');
    setHistoryStack([]);
    setHistoryIndex(-1);
    setLoadError(null);
    setIsLoading(false);
  };

  const copyDomainToClipboard = () => {
    if (!myDomain) return;
    navigator.clipboard.writeText(`${myDomain}.p2p`);
    showToast('📋 Domínio copiado para o clipboard!');
  };

  return (
    <div className="h-screen w-screen flex flex-col font-sans bg-[#0b141a] text-[#d1d7db] overflow-hidden select-none">
      
      {/* HEADER PRINCIPAL */}
      <header className="h-[60px] bg-[#202c33] border-b border-[#2a3942] px-5 flex items-center justify-between flex-shrink-0 z-50">
        <div className="flex items-center gap-3">
          <Globe className="w-7 h-7 text-[#00a884] animate-pulse" />
          <h1 className="text-xl font-bold text-[#00a884] tracking-tight">P2P Web</h1>
        </div>

        {/* CONTROLES DE CONEXÃO E BOTÃO DE VIRAR HOST / VISITANTE */}
        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 bg-[#2a3942] px-4 py-1.5 rounded-full text-xs">
            {isPeerReady ? (
              <span className="w-2.5 h-2.5 rounded-full bg-[#00a884] shadow-[0_0_8px_#00a884]" />
            ) : (
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-500 animate-pulse" />
            )}
            <span className="text-gray-300 font-medium">
              {isHost ? (myDomain ? `${myDomain}.p2p` : 'Host sem domínio') : 'Visitante'}
            </span>
          </div>

          <button
            onClick={handleModeToggle}
            className={`px-4 py-2 text-xs font-semibold rounded-full duration-250 transition-all flex items-center gap-1.5 shadow ${
              isHost 
                ? 'bg-[#00a884] hover:bg-[#008f70] text-white' 
                : 'bg-[#2a3942] hover:bg-[#374955] text-white'
            }`}
          >
            {isHost ? (
              <>
                <User className="w-3.5 h-3.5" />
                Navegar como Visitante
              </>
            ) : (
              <>
                <Server className="w-3.5 h-3.5" />
                Ativar Host P2P
              </>
            )}
          </button>
        </div>
      </header>

      {/* ÁREA INTERACTIVA PRINCIPAL */}
      <main className="flex-1 flex overflow-hidden relative">
        
        {/* SIDEBAR (CONFIGURAÇÕES DO HOST OU EXPLICAÇÕES) */}
        <AnimatePresence mode="popLayout">
          {sidebarOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 340, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="bg-[#111b21] border-r border-[#2a3942] flex flex-col overflow-y-auto flex-shrink-0"
            >
              <div className="p-5 flex-1 flex flex-col gap-6">
                
                {isHost ? (
                  <>
                    {/* SEÇÃO CONFIGURAR DOMÍNIO */}
                    <div className="flex flex-col gap-3">
                      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                        Meu Domínio Descentralizado
                      </h3>
                      
                      <div className="bg-[#202c33] p-4 rounded-xl flex flex-col gap-3 border border-[#2a3942]">
                        <div className="flex items-center gap-1 bg-[#2a3942] p-1 rounded-lg">
                          <input
                            type="text"
                            value={registerDomainInput}
                            onChange={(e) => setRegisterDomainInput(e.target.value)}
                            placeholder="ex: meusite"
                            className="bg-transparent border-none outline-none text-sm px-2 py-1.5 flex-1 text-white font-mono"
                          />
                          <span className="text-[#8696a0] text-sm pr-3 font-mono">.p2p</span>
                        </div>
                        
                        <button
                          onClick={handleRegisterDomain}
                          className="w-full bg-[#00a884] hover:bg-[#008f70] transition-colors text-white py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Registrar Domínio
                        </button>

                        {myDomain && (
                          <div className="flex items-center justify-between bg-[#111b21] p-2.5 rounded-lg border border-[#2a3942] mt-1 text-xs">
                            <span className="text-gray-300 font-mono truncate">{myDomain}.p2p</span>
                            <div className="flex items-center gap-1">
                              <button 
                                onClick={copyDomainToClipboard} 
                                className="p-1.5 hover:bg-[#202c33] text-gray-400 hover:text-white rounded"
                                title="Copiar Domínio"
                              >
                                <Copy className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* SEÇÃO PUBLICAR SITE DO LOCALHOST */}
                    <div className="flex flex-col gap-3">
                      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                        Servidor de Origem Local
                      </h3>

                      <div className="bg-[#202c33] p-4 rounded-xl flex flex-col gap-3 border border-[#2a3942]">
                        <p className="text-[11px] text-[#8696a0] leading-relaxed">
                          Mapeie seu servidor web local (ex: rodando no Apache, Node, Nginx) para torná-lo acessível ponto a ponto.
                        </p>

                        <input
                          type="text"
                          value={publishUrlInput}
                          onChange={(e) => setPublishUrlInput(e.target.value)}
                          placeholder="http://localhost:8080"
                          className="bg-[#2a3942] border-none outline-none rounded-lg text-sm px-3 py-2 text-white font-mono"
                        />

                        <button
                          onClick={handlePublishSite}
                          className="w-full bg-[#2a3942] hover:bg-[#374955] transition-colors text-[#00a884] border border-[#00a884]/30 py-2 rounded-lg text-xs font-semibold"
                        >
                          Vincular Localhost
                        </button>
                      </div>
                    </div>

                    {/* MEUS SITES SINALIZADOS */}
                    <div className="flex flex-col gap-3 flex-1">
                      <h3 className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                        Sites Publicados via P2P
                      </h3>

                      {mySites.length > 0 ? (
                        <div className="flex flex-col gap-2">
                          {mySites.map((site, index) => (
                            <div key={index} className="bg-[#202c33] border border-[#2a3942] p-3 rounded-lg flex items-center justify-between">
                              <div className="flex flex-col gap-0.5 overflow-hidden">
                                <span className="text-xs font-semibold text-[#00a884] truncate">
                                  {myDomain}.p2p
                                </span>
                                <span className="text-[11px] text-gray-400 truncate">
                                  Direciona para: {site.url}
                                </span>
                              </div>
                              <button
                                onClick={handleRemoveSite}
                                className="p-2 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="p-6 rounded-xl border border-dashed border-[#2a3942] text-center flex flex-col items-center justify-center gap-2 text-xs text-[#8696a0]">
                          <HelpCircle className="w-8 h-8 text-gray-500" />
                          <span>Nenhum servidor web publicado. Outros usuários não conseguirão acessar seus dados enquanto não publicar um localhost.</span>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  // PAINEL DE VISITANTE EXPLICATIVO
                  <div className="flex flex-col gap-5 flex-1 justify-center py-6 text-center">
                    <div className="w-16 h-16 bg-[#00a884]/10 rounded-full flex items-center justify-center mx-auto">
                      <Globe className="w-8 h-8 text-[#00a884]" />
                    </div>
                    <div>
                      <h4 className="text-base font-semibold text-white">Navegando na Web P2P</h4>
                      <p className="text-xs text-[#8696a0] mt-2 leading-relaxed">
                        Você está no modo visitante. Digite qualquer domínio .p2p válido na barra de navegação à direita para se conectar diretamente ao computador de outro usuário e visualizar o site dele.
                      </p>
                    </div>

                    <div className="bg-[#202c33] border border-[#2a3942] p-4 rounded-xl text-left">
                      <h5 className="text-xs font-bold text-[#00a884] uppercase mb-1.5 flex items-center gap-1">
                        <CheckCircle className="w-3.5 h-3.5" />
                        Privacidade nativa
                      </h5>
                      <p className="text-[11px] text-gray-300 leading-relaxed">
                        Tudo trafega por canais criptografados WebSocket/WebRTC descartáveis, sem bases de dados centralizadas rastreando sua sessão.
                      </p>
                    </div>

                    <button
                      onClick={handleModeToggle}
                      className="mt-4 w-full bg-[#00a884] hover:bg-[#008f70] text-white py-2.5 rounded-xl font-semibold text-xs transition-colors"
                    >
                      Desejo publicar meu próprio site
                    </button>
                  </div>
                )}
                
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* NAVEGADOR (ÁREA DE ENVELOPE DO IFRAME E BARRA DE ENDEREÇO) */}
        <div className="flex-1 bg-white flex flex-col relative overflow-hidden">
          
          {/* BARRA DE BOTÕES DE NAVEGAÇÃO E URL BAR */}
          <div className="h-[56px] bg-[#202c33] border-b border-[#2a3942] px-4 flex items-center gap-3 flex-shrink-0 shadow-sm">
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleGoBack}
                disabled={historyIndex <= 0}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-[#2a3942] disabled:opacity-30 disabled:hover:bg-transparent text-white cursor-pointer transition-colors"
                title="Voltar"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <button
                onClick={handleGoForward}
                disabled={historyIndex >= historyStack.length - 1}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-[#2a3942] disabled:opacity-30 disabled:hover:bg-transparent text-white cursor-pointer transition-colors"
                title="Avançar"
              >
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={handleRefresh}
                className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-[#2a3942] text-white cursor-pointer transition-colors"
                title="Atualizar"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {/* INPUT DE NAVEGAÇÃO */}
            <div className="flex-1 bg-[#2a3942] h-[38px] rounded-full px-4 flex items-center gap-2 border border-[#374955]/20">
              <span className="text-[13px] text-[#8696a0] font-mono select-none">p2p://</span>
              <input
                type="text"
                value={browserInput}
                onChange={(e) => setBrowserInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleGoSubmit()}
                placeholder="meusite.p2p"
                className="bg-transparent border-none outline-none text-sm text-white font-mono flex-1 w-full"
              />
            </div>

            <button
              onClick={handleGoSubmit}
              className="bg-[#00a884] hover:bg-[#008f70] transition-colors rounded-full text-xs font-bold text-white px-5 py-2"
            >
              Ir para
            </button>
          </div>

          {/* ÁREA DE CONTEÚDO DO WEB BROWSER */}
          <div className="flex-1 relative bg-white">
            
            {/* CARREGAMENTO SPIN */}
            {isLoading && (
              <div className="absolute inset-0 bg-white/95 flex flex-col items-center justify-center gap-3 z-30">
                <Loader2 className="w-8 h-8 text-[#00a884] animate-spin" />
                <span className="text-xs text-gray-500 font-medium">Buscando conteúdo ponto-a-ponto...</span>
              </div>
            )}

            {/* TELA DE ERRO */}
            {loadError && (
              <div className="absolute inset-0 bg-gray-50/98 flex flex-col items-center justify-center gap-4 z-40 p-6 text-center">
                <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center text-red-500">
                  <AlertTriangle className="w-8 h-8" />
                </div>
                <div className="max-w-md">
                  <h3 className="text-base font-bold text-gray-900">Erro de Carregamento Descentralizado</h3>
                  <p className="text-xs text-gray-500 mt-2 leading-relaxed">{loadError}</p>
                </div>
                <button
                  onClick={handleRefresh}
                  className="bg-[#202c33] hover:bg-[#111b21] transition-colors text-white font-semibold text-xs px-5 py-2 rounded-full flex items-center gap-1.5 shadow"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Tentar novamente
                </button>
              </div>
            )}

            {/* SE NÃO ESTIVER EM NENHUM DOMÍNIO, MOSTRA TELA INICIAL */}
            {!currentDomain && !isLoading && !loadError && (
              <div className="absolute inset-0 bg-[#f4f6f9] flex flex-col items-center justify-center text-center p-8 z-10 overflow-y-auto">
                <div className="max-w-md flex flex-col items-center gap-5">
                  <div className="w-20 h-20 bg-white rounded-2xl flex items-center justify-center shadow-md border border-gray-100">
                    <Globe className="w-10 h-10 text-[#00a884]" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-gray-800">Sistema Descobridor P2P Web</h2>
                    <p className="text-xs text-gray-500 mt-2.5 leading-relaxed">
                      Navegue de forma descentralizada. Os sites são transferidos sem intermediários por conexões diretas entre você e o host.
                    </p>
                  </div>

                  <div className="bg-white border border-gray-100 p-4 rounded-xl text-left shadow-sm w-full">
                    <h4 className="text-xs font-bold text-gray-800 uppercase mb-2">Exemplos rápidos:</h4>
                    <div className="flex flex-col gap-2 font-mono text-xs">
                      <button
                        onClick={() => {
                          setBrowserInput('demo.p2p');
                          navigateTo('demo', '/');
                        }}
                        className="text-left text-[#00a884] hover:underline flex items-center gap-1.5"
                      >
                        ⚡ p2p://demo.p2p
                      </button>
                      <button
                        onClick={() => {
                          setBrowserInput('blog.p2p');
                          navigateTo('blog', '/');
                        }}
                        className="text-left text-[#00a884] hover:underline flex items-center gap-1.5"
                      >
                        ⚡ p2p://blog.p2p
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* IFRAME REAL DO SITE */}
            <iframe
              ref={iframeRef}
              className="w-full h-full border-none bg-white z-20"
              title="P2P Web Sandbox Browser"
            />
          </div>
        </div>
      </main>

      {/* TOAST PANEL */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 40, x: '-50%' }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#202c33] border border-[#2a3942] text-white text-xs py-3 px-6 rounded-full shadow-2xl z-50 flex items-center gap-2 max-w-[90%]"
          >
            <div className="w-2 h-2 rounded-full bg-[#00a884]" />
            <span>{toastMessage}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* BOTÃO FLUTUANTE DA SIDEBAR */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="fixed bottom-5 right-5 w-12 h-12 rounded-full bg-[#00a884] hover:bg-[#008f70] text-white flex items-center justify-center shadow-2xl cursor-pointer transition-transform duration-200 z-50"
        title={sidebarOpen ? "Fechar Configurações" : "Abrir Configurações"}
      >
        {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
      </button>

    </div>
  );
}
