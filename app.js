/**
 * ═══════════════════════════════════════════════════════════
 *  Mediquo — Frontend (app.js)
 *  Fluxo: Formulário → Confirmação → Pagamento → Agendamento
 * ═══════════════════════════════════════════════════════════
 *
 *  ⚠  CONFIGURAÇÃO OBRIGATÓRIA:
 *  1. Substitua APPS_SCRIPT_URL pela URL do seu Apps Script
 *     após fazer o deploy como Web App.
 *  2. Substitua HMAC_SECRET por um valor aleatório (hex 32+ bytes)
 *     e configure o MESMO valor no PropertiesService do Apps Script
 *     com a chave HMAC_SECRET.
 *
 *  SEGURANÇA:
 *  - Todas as requisições ao backend usam POST com payload
 *    assinado via HMAC-SHA256 (Web Crypto API nativa).
 *  - Cada requisição inclui timestamp (ts) com janela de 5 min.
 *  - Session token emitido pelo backend (action 'iniciar') vincula
 *    o fluxo form → pagamento → agendamento a uma sessão verificável.
 *  - O segredo HMAC é visível no source; protege contra
 *    manipulação casual, não substitui autenticação real.
 */

(function () {
  'use strict';

  /* ─── CONFIGURAÇÃO ─────────────────────────────────────── */

  /**
   * Cole aqui a URL do deploy do Apps Script.
   * Menu: Implantar → Nova implantação → Web App → Copiar URL
   * Formato: https://script.google.com/macros/s/XXXX/exec
   */
  var APPS_SCRIPT_URL = 'COLE_SUA_URL_DO_APPS_SCRIPT_AQUI';

  var PAYMENT_URL = 'https://payment-link-v3.pagar.me/pl_a3JqYmygNDV6G7Bceilp6j7ERnlxG9WO';

  /**
   * Segredo HMAC — deve ser idêntico ao configurado no PropertiesService
   * do Apps Script (chave: HMAC_SECRET).
   *
   * ⚠  Este valor é visível no código-fonte do frontend.
   *    Ele protege contra manipulação casual e bots oportunistas,
   *    mas NÃO substitui autenticação real.
   *    Gere um valor aleatório com: openssl rand -hex 32
   */
  var HMAC_SECRET = '578ce3e6969abe5fd77a269b1f3ea5dabfed56cfa5165bd2d20de91cfaacf0fd';

  var POLL_INTERVAL_MS   = 5000;   // 5 segundos entre cada polling
  var POLL_MAX_ATTEMPTS  = 120;    // 10 minutos máximo (120 × 5s)
  var COUNTDOWN_SECONDS  = 10;

  /* ─── Estado ───────────────────────────────────────────── */

  var state = {
    nome:         '',
    cpf:          '',
    ddd:          '',
    telefone:     '',
    sessionToken: '',
    step:         'form',
    pollTimer:        null,
    pollAttempts:     0,
    countdownTimer:   null
  };

  /* ─── DOM ──────────────────────────────────────────────── */

  var $ = function (sel) { return document.querySelector(sel); };

  var dom = {
    stepForm:       $('#stepForm'),
    stepConfirm:    $('#stepConfirm'),
    stepPayment:    $('#stepPayment'),
    stepSchedule:   $('#stepSchedule'),

    inputNome:      $('#inputNome'),
    inputCPF:       $('#inputCPF'),
    inputDDD:       $('#inputDDD'),
    inputTelefone:  $('#inputTelefone'),
    errorNome:      $('#errorNome'),
    errorCPF:       $('#errorCPF'),
    errorDDD:       $('#errorDDD'),
    errorTelefone:  $('#errorTelefone'),
    btnContinuar:   $('#btnContinuar'),

    confirmNome:    $('#confirmNome'),
    confirmCPF:     $('#confirmCPF'),
    confirmTelefone:$('#confirmTelefone'),
    countdown:      $('#countdown'),
    btnVoltarForm:  $('#btnVoltarForm'),
    btnPagar:       $('#btnPagar'),

    iframeContainer:$('#iframeContainer'),
    iframeLoading:  $('#iframeLoading'),
    paymentIframe:  $('#paymentIframe'),
    iframeFallback: $('#iframeFallback'),
    paymentLink:    $('#paymentLink'),
    pollingStatus:  $('#pollingStatus'),
    btnCheckManual: $('#btnCheckManual'),

    btnAgendar:     $('#btnAgendar'),
    agendarError:   $('#agendarError'),

    themeToggle:    $('#themeToggle'),
    iconMoon:       $('#iconMoon'),
    iconSun:        $('#iconSun'),
    yearFooter:     $('#yearFooter')
  };

  /* ─── Tema ─────────────────────────────────────────────── */

  function initTheme() {
    var saved = localStorage.getItem('theme');
    setTheme(saved === 'light' ? 'light' : 'dark');
    if (dom.themeToggle) {
      dom.themeToggle.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme') || 'dark';
        setTheme(current === 'dark' ? 'light' : 'dark');
      });
    }
  }

  function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('theme', theme); } catch (_) {}
    if (dom.iconMoon) dom.iconMoon.style.display = theme === 'dark' ? 'block' : 'none';
    if (dom.iconSun)  dom.iconSun.style.display  = theme === 'light' ? 'block' : 'none';
  }

  /* ─── Toast ────────────────────────────────────────────── */

  var toastTimeout;

  function showToast(msg, type) {
    var existing = document.querySelector('.toast');
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });

    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 400);
    }, 4000);
  }

  /* ─── HMAC — Assinatura de Requisição ────────────────────── */

  /**
   * Calcula HMAC-SHA256 usando Web Crypto API (nativo do browser).
   * Retorna Promise<string> com o hex digest.
   */
  function computeHMAC(message) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey(
      'raw', enc.encode(HMAC_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    ).then(function (key) {
      return crypto.subtle.sign('HMAC', key, enc.encode(message));
    }).then(function (sigBuf) {
      var bytes = new Uint8Array(sigBuf);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) {
        hex += ('0' + bytes[i].toString(16)).slice(-2);
      }
      return hex;
    });
  }

  /**
   * Cria o body assinado para envio via POST.
   * Formato: { payload: "<json-stringificado>", sig: "<hmac-hex>" }
   * Inclui timestamp (ts) para proteção anti-replay.
   * Retorna Promise<string>.
   */
  function buildSignedBody(data) {
    data.ts = Date.now();
    var payloadStr = JSON.stringify(data);

    return computeHMAC(payloadStr).then(function (sig) {
      return JSON.stringify({ payload: payloadStr, sig: sig });
    });
  }

  /**
   * Envia POST assinado ao Apps Script.
   * Content-Type: text/plain evita preflight CORS.
   * Retorna Promise<Response>.
   */
  function signedFetch(data) {
    return buildSignedBody(data).then(function (body) {
      return fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: body
      });
    });
  }

  /* ─── Máscaras de Input ────────────────────────────────── */

  function maskCPF(value) {
    var digits = value.replace(/\D/g, '').substring(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return digits.substring(0, 3) + '.' + digits.substring(3);
    if (digits.length <= 9) return digits.substring(0, 3) + '.' + digits.substring(3, 6) + '.' + digits.substring(6);
    return digits.substring(0, 3) + '.' + digits.substring(3, 6) + '.' + digits.substring(6, 9) + '-' + digits.substring(9);
  }

  function maskPhone(value) {
    var digits = value.replace(/\D/g, '').substring(0, 9);
    if (digits.length <= 5) return digits;
    return digits.substring(0, 5) + '-' + digits.substring(5);
  }

  function maskDDD(value) {
    return value.replace(/\D/g, '').replace(/^0+/, '').substring(0, 2);
  }

  function setupMasks() {
    dom.inputCPF.addEventListener('input', function () {
      var pos = this.selectionStart;
      var oldLen = this.value.length;
      this.value = maskCPF(this.value);
      var newLen = this.value.length;
      var newPos = pos + (newLen - oldLen);
      this.setSelectionRange(newPos, newPos);
    });

    dom.inputDDD.addEventListener('input', function () {
      this.value = maskDDD(this.value);
    });

    dom.inputTelefone.addEventListener('input', function () {
      var pos = this.selectionStart;
      var oldLen = this.value.length;
      this.value = maskPhone(this.value);
      var newLen = this.value.length;
      var newPos = pos + (newLen - oldLen);
      this.setSelectionRange(newPos, newPos);
    });

    dom.inputNome.addEventListener('input', function () {
      this.value = this.value.replace(/[^a-zA-ZÀ-ÿ\s]/g, '');
    });
  }

  /* ─── Validação de CPF ─────────────────────────────────── */

  function isValidCPF(cpf) {
    var digits = cpf.replace(/\D/g, '');
    if (digits.length !== 11) return false;

    // Rejeitar sequências iguais
    var allSame = true;
    for (var i = 1; i < 11; i++) {
      if (digits[i] !== digits[0]) { allSame = false; break; }
    }
    if (allSame) return false;

    // Dígito verificador 1
    var sum = 0;
    for (var j = 0; j < 9; j++) sum += parseInt(digits[j], 10) * (10 - j);
    var d1 = (sum * 10) % 11;
    if (d1 === 10) d1 = 0;
    if (d1 !== parseInt(digits[9], 10)) return false;

    // Dígito verificador 2
    sum = 0;
    for (var k = 0; k < 10; k++) sum += parseInt(digits[k], 10) * (11 - k);
    var d2 = (sum * 10) % 11;
    if (d2 === 10) d2 = 0;
    if (d2 !== parseInt(digits[10], 10)) return false;

    return true;
  }

  /* ─── Validação do Formulário ──────────────────────────── */

  function validateForm() {
    var valid = true;

    // Nome
    var nome = dom.inputNome.value.trim();
    if (!nome || nome.length < 3) {
      setFieldError(dom.inputNome, dom.errorNome, 'Informe seu nome completo');
      valid = false;
    } else if (nome.indexOf(' ') === -1) {
      setFieldError(dom.inputNome, dom.errorNome, 'Informe nome e sobrenome');
      valid = false;
    } else {
      clearFieldError(dom.inputNome, dom.errorNome);
    }

    // CPF
    var cpfRaw = dom.inputCPF.value.replace(/\D/g, '');
    if (!cpfRaw || cpfRaw.length !== 11) {
      setFieldError(dom.inputCPF, dom.errorCPF, 'CPF deve ter 11 dígitos');
      valid = false;
    } else if (!isValidCPF(cpfRaw)) {
      setFieldError(dom.inputCPF, dom.errorCPF, 'CPF inválido');
      valid = false;
    } else {
      clearFieldError(dom.inputCPF, dom.errorCPF);
    }

    // DDD
    var ddd = dom.inputDDD.value.replace(/\D/g, '');
    if (!ddd || ddd.length !== 2) {
      setFieldError(dom.inputDDD, dom.errorDDD, 'DDD inválido');
      valid = false;
    } else if (ddd[0] === '0') {
      setFieldError(dom.inputDDD, dom.errorDDD, 'DDD não pode começar com 0');
      valid = false;
    } else {
      clearFieldError(dom.inputDDD, dom.errorDDD);
    }

    // Telefone
    var tel = dom.inputTelefone.value.replace(/\D/g, '');
    if (!tel || tel.length !== 9) {
      setFieldError(dom.inputTelefone, dom.errorTelefone, 'Telefone deve ter 9 dígitos');
      valid = false;
    } else {
      clearFieldError(dom.inputTelefone, dom.errorTelefone);
    }

    return valid;
  }

  function setFieldError(input, errorEl, msg) {
    input.classList.add('field-error-state');
    if (errorEl) errorEl.textContent = msg;
  }

  function clearFieldError(input, errorEl) {
    input.classList.remove('field-error-state');
    if (errorEl) errorEl.textContent = '';
  }

  /* ─── Navegação entre Steps ────────────────────────────── */

  function showStep(stepName) {
    state.step = stepName;
    dom.stepForm.style.display    = stepName === 'form'     ? '' : 'none';
    dom.stepConfirm.style.display = stepName === 'confirm'  ? '' : 'none';
    dom.stepPayment.style.display = stepName === 'payment'  ? '' : 'none';
    dom.stepSchedule.style.display= stepName === 'schedule' ? '' : 'none';

    // Scroll ao topo ao mudar step
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ─── Step 1 → Step 2 ─────────────────────────────────── */

  function goToConfirm() {
    if (!validateForm()) return;

    state.nome     = dom.inputNome.value.trim();
    state.cpf      = dom.inputCPF.value.replace(/\D/g, '');
    state.ddd      = dom.inputDDD.value.replace(/\D/g, '');
    state.telefone = dom.inputTelefone.value.replace(/\D/g, '');

    // Persistir em sessionStorage para sobreviver a refresh
    saveFormToSession();

    // Preencher resumo
    dom.confirmNome.textContent     = state.nome;
    dom.confirmCPF.textContent      = maskCPF(state.cpf);
    dom.confirmTelefone.textContent = '(' + state.ddd + ') ' + maskPhone(state.telefone);

    showStep('confirm');
    startCountdown();
  }

  /* ─── Persistência sessionStorage ──────────────────────── */

  function saveFormToSession() {
    try {
      sessionStorage.setItem('mediquo_form', JSON.stringify({
        nome: state.nome, cpf: state.cpf, ddd: state.ddd, telefone: state.telefone
      }));
    } catch (_) {}
  }

  function saveSessionToken() {
    try {
      sessionStorage.setItem('mediquo_session_token', state.sessionToken);
    } catch (_) {}
  }

  function loadSessionToken() {
    try {
      return sessionStorage.getItem('mediquo_session_token') || '';
    } catch (_) {
      return '';
    }
  }

  function clearSessionToken() {
    try {
      sessionStorage.removeItem('mediquo_session_token');
    } catch (_) {}
    state.sessionToken = '';
  }

  /* ─── Countdown de 10 segundos ─────────────────────────── */

  function startCountdown() {
    var remaining = COUNTDOWN_SECONDS;
    dom.btnPagar.disabled = true;
    updateCountdownUI(remaining);

    clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(function () {
      remaining--;
      if (remaining <= 0) {
        clearInterval(state.countdownTimer);
        dom.btnPagar.disabled = false;
        dom.btnPagar.querySelector('.btn-text').textContent = 'Seguir para pagamento';
      } else {
        updateCountdownUI(remaining);
      }
    }, 1000);
  }

  function updateCountdownUI(secs) {
    dom.countdown.textContent = secs;
    dom.btnPagar.querySelector('.btn-text').textContent = 'Seguir para pagamento (' + secs + 's)';
  }

  /* ─── Step 2 → Step 3 (Pagamento) ──────────────────────── */

  /**
   * Ao clicar "Seguir para pagamento":
   * 1. Tenta reutilizar session token existente (sessionStorage)
   * 2. Se não existe ou falhou, solicita novo token ao backend (action 'iniciar')
   * 3. Somente após obter token válido, abre o iframe de pagamento
   */
  function goToPayment() {
    var btnText = dom.btnPagar.querySelector('.btn-text');

    // ── Desabilitar botão durante a solicitação ──
    dom.btnPagar.disabled = true;
    btnText.textContent = 'Preparando sessão...';

    // ── Tentar reutilizar token existente ──
    var existingToken = loadSessionToken();
    if (existingToken) {
      state.sessionToken = existingToken;
      proceedToPaymentStep();
      return;
    }

    // ── Solicitar novo session token ao backend ──
    requestNewSession(function onSuccess() {
      proceedToPaymentStep();
    }, function onError(errMsg) {
      showToast(errMsg || 'Erro ao iniciar sessão. Tente novamente.', 'error');
      dom.btnPagar.disabled = false;
      btnText.textContent = 'Seguir para pagamento';
    });
  }

  /**
   * Solicita session token ao backend via action 'iniciar'.
   * O token é armazenado em state.sessionToken e em sessionStorage.
   *
   * @param {Function} onSuccess - Callback em caso de sucesso
   * @param {Function} onError   - Callback em caso de erro (recebe mensagem)
   */
  function requestNewSession(onSuccess, onError) {
    signedFetch({
      action:   'iniciar',
      cpf:      state.cpf,
      nome:     state.nome,
      ddd:      state.ddd,
      telefone: state.telefone
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.status === 'success' && data.session_token) {
          state.sessionToken = data.session_token;
          saveSessionToken();
          onSuccess();
        } else {
          throw new Error(data.message || 'Resposta inesperada do servidor');
        }
      })
      .catch(function (err) {
        console.error('[requestNewSession] Erro:', err.message);
        clearSessionToken();
        onError('Erro ao iniciar sessão: ' + err.message);
      });
  }

  /**
   * Efetivamente abre o step de pagamento (iframe + polling).
   * Chamado somente após session token válido.
   */
  function proceedToPaymentStep() {
    showStep('payment');

    // Configurar iframe
    dom.paymentLink.href = PAYMENT_URL;
    dom.paymentIframe.src = PAYMENT_URL;

    // Mostrar fallback após 5 segundos (caso iframe não carregue)
    setTimeout(function () {
      if (dom.iframeFallback) dom.iframeFallback.style.display = '';
    }, 5000);

    // Esconder loading quando iframe carregar
    dom.paymentIframe.addEventListener('load', function () {
      if (dom.iframeLoading) dom.iframeLoading.style.display = 'none';
    });

    // Iniciar polling
    startPolling();
  }

  /* ─── Polling de status de pagamento ───────────────────── */

  function startPolling() {
    state.pollAttempts = 0;
    clearInterval(state.pollTimer);
    checkPaymentStatus(); // Primeira chamada imediata
    state.pollTimer = setInterval(checkPaymentStatus, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function checkPaymentStatus() {
    state.pollAttempts++;

    if (state.pollAttempts > POLL_MAX_ATTEMPTS) {
      stopPolling();
      if (dom.pollingStatus) {
        dom.pollingStatus.innerHTML =
          '<span style="color:var(--color-warning);">Tempo de verificação esgotado. Use o botão abaixo para tentar novamente.</span>';
      }
      return;
    }

    signedFetch({
      action:        'status',
      cpf:           state.cpf,
      ddd:           state.ddd,
      telefone:      state.telefone,
      session_token: state.sessionToken
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.found === true) {
          stopPolling();
          goToSchedule();
        }
        // Se sessão expirou, tentar renovar silenciosamente
        if (data && data.message && data.message.indexOf('Sessão') !== -1) {
          console.warn('[polling] Sessão expirada. Tentando renovar...');
          clearSessionToken();
          requestNewSession(function () {
            console.log('[polling] Sessão renovada com sucesso');
          }, function () {
            console.warn('[polling] Falha ao renovar sessão');
          });
        }
      })
      .catch(function (err) {
        // Silencioso — apenas log. O polling continuará tentando.
        console.warn('[polling] Erro na tentativa ' + state.pollAttempts + ':', err.message);
      });
  }

  /* ─── Check manual ─────────────────────────────────────── */

  function manualCheck() {
    dom.btnCheckManual.disabled = true;
    dom.btnCheckManual.textContent = 'Verificando...';

    signedFetch({
      action:        'status',
      cpf:           state.cpf,
      ddd:           state.ddd,
      telefone:      state.telefone,
      session_token: state.sessionToken
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.found === true) {
          stopPolling();
          goToSchedule();
        } else if (data && data.message && data.message.indexOf('Sessão') !== -1) {
          // Sessão expirada — tentar renovar e refazer check
          clearSessionToken();
          requestNewSession(function () {
            // Refazer check com novo token
            manualCheck();
          }, function () {
            showToast('Sessão expirada. Por favor, reinicie o processo.', 'error');
          });
          return; // Evitar restaurar botão prematuramente
        } else {
          showToast('Pagamento ainda não confirmado. Aguarde alguns instantes.', 'error');
        }
      })
      .catch(function () {
        showToast('Erro ao verificar. Tente novamente.', 'error');
      })
      .finally(function () {
        dom.btnCheckManual.disabled = false;
        dom.btnCheckManual.textContent = 'Já paguei, verificar agora';
      });
  }

  /* ─── Step 3 → Step 4 (Agendamento) ────────────────────── */

  function goToSchedule() {
    showStep('schedule');
    showToast('Pagamento confirmado!', 'success');
  }

  /* ─── Gerar link de agendamento ────────────────────────── */

  function requestSchedulingLink() {
    var btnText = dom.btnAgendar.querySelector('.btn-text');
    var btnLoader = dom.btnAgendar.querySelector('.btn-loader');

    btnText.style.display = 'none';
    btnLoader.style.display = 'inline-flex';
    dom.btnAgendar.disabled = true;
    dom.agendarError.textContent = '';

    signedFetch({
      action:        'agendar',
      cpf:           state.cpf,
      nome:          state.nome,
      ddd:           state.ddd,
      telefone:      state.telefone,
      session_token: state.sessionToken
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (data && data.status === 'success' && data.link) {
          showToast('Link gerado! Redirecionando...', 'success');
          // Abrir em nova aba
          setTimeout(function () {
            window.open(data.link, '_blank', 'noopener,noreferrer');
          }, 800);

          // Atualizar botão para permitir reabrir
          btnText.textContent = 'Abrir link de agendamento';
          btnText.style.display = '';
          btnLoader.style.display = 'none';
          dom.btnAgendar.disabled = false;

          // Trocar handler para reabrir o link
          dom.btnAgendar.onclick = function () {
            window.open(data.link, '_blank', 'noopener,noreferrer');
          };
        } else if (data && data.message && data.message.indexOf('Sessão') !== -1) {
          // Sessão expirada — tentar renovar e refazer
          clearSessionToken();
          requestNewSession(function () {
            btnText.style.display = '';
            btnLoader.style.display = 'none';
            dom.btnAgendar.disabled = false;
            showToast('Sessão renovada. Clique novamente para gerar o link.', 'success');
          }, function () {
            throw new Error('Sessão expirada. Por favor, reinicie o processo.');
          });
          return;
        } else {
          throw new Error(data.message || 'Erro desconhecido');
        }
      })
      .catch(function (err) {
        dom.agendarError.textContent = 'Erro: ' + err.message + '. Tente novamente.';
        btnText.style.display = '';
        btnLoader.style.display = 'none';
        dom.btnAgendar.disabled = false;
      });
  }

  /* ─── Restaurar estado de sessionStorage ───────────────── */

  function restoreSession() {
    try {
      var saved = sessionStorage.getItem('mediquo_form');
      if (!saved) return false;

      var data = JSON.parse(saved);
      if (data.nome && data.cpf && data.ddd && data.telefone) {
        state.nome     = data.nome;
        state.cpf      = data.cpf;
        state.ddd      = data.ddd;
        state.telefone = data.telefone;

        dom.inputNome.value     = data.nome;
        dom.inputCPF.value      = maskCPF(data.cpf);
        dom.inputDDD.value      = data.ddd;
        dom.inputTelefone.value = maskPhone(data.telefone);

        // Restaurar session token se existir
        var storedToken = loadSessionToken();
        if (storedToken) {
          state.sessionToken = storedToken;
        }

        return true;
      }
    } catch (_) {}
    return false;
  }

  /* ─── Inicialização ────────────────────────────────────── */

  function init() {
    if (dom.yearFooter) dom.yearFooter.textContent = new Date().getFullYear();

    initTheme();
    setupMasks();
    restoreSession();

    // Step 1 → Step 2
    dom.btnContinuar.addEventListener('click', goToConfirm);

    // Step 2 → Voltar
    dom.btnVoltarForm.addEventListener('click', function () {
      clearInterval(state.countdownTimer);
      showStep('form');
    });

    // Step 2 → Step 3
    dom.btnPagar.addEventListener('click', goToPayment);

    // Check manual
    dom.btnCheckManual.addEventListener('click', manualCheck);

    // Step 4 → Gerar link
    dom.btnAgendar.addEventListener('click', requestSchedulingLink);

    // Enter no form = continuar
    var formInputs = [dom.inputNome, dom.inputCPF, dom.inputDDD, dom.inputTelefone];
    formInputs.forEach(function (input) {
      if (input) {
        input.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') goToConfirm();
        });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
