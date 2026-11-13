// public/js/session-store.js
// Resume credentials (roomId / resumeToken / playerIndex / game) live in localStorage with a saved-at
// timestamp so a closed tab or browser can resume the seat; they expire after one year.
// They are mirrored into sessionStorage because the renderers read playerIndex / roomId from there.
// Also remembers the player's name and avatar (gn_name / gn_avatar).
(function(root) {
  var KEY = 'gn_session';
  var TTL = 365 * 24 * 60 * 60 * 1000;
  var FIELDS = ['roomId', 'resumeToken', 'playerIndex', 'game'];
  var lastTouch = 0;

  function ls() { try { return root.localStorage; } catch (e) { return null; } }
  function ss() { try { return root.sessionStorage; } catch (e) { return null; } }

  function mirror(data) {
    var s = ss();
    if (!s) return;
    try {
      FIELDS.forEach(function(k) {
        if (data && data[k] != null && k !== 'resumeToken') s.setItem(k, String(data[k]));
        else s.removeItem(k);
      });
    } catch (e) {}
  }

  function read() {
    var l = ls();
    if (!l) return null;
    try {
      var d = JSON.parse(l.getItem(KEY));
      return d && typeof d === 'object' ? d : null;
    } catch (e) { return null; }
  }

  function write(d) {
    var l = ls();
    if (!l) return;
    try { l.setItem(KEY, JSON.stringify(d)); } catch (e) {}
  }

  var api = {
    TTL: TTL,
    getLoginHistory:function(){try{var h=JSON.parse(localStorage.getItem('gn_login_history')||'[]');return Array.isArray(h)?h.filter(function(u){return u&&typeof u.name==='string'}).slice(0,30):[]}catch(e){return []}},
    rememberLogin:function(name,id){var n=api.validName(name);if(!n)return;try{var h=api.getLoginHistory().filter(function(u){return id&&u.id?id!==u.id:u.name!==n});h.unshift({name:n,id:id||null});localStorage.setItem('gn_login_history',JSON.stringify(h.slice(0,30)));}catch(e){}},
    logout:function(){api.invalidateIdentity(api.getIdentity());try{localStorage.removeItem('gn_name');localStorage.removeItem('gn_avatar');}catch(e){}},
    getIdentity:function(){try{
      if(sessionStorage.getItem('gn_login_blocked'))return '';
      // Pin this tab's credential before its first handshake. A frozen old tab
      // cannot borrow a newer tab's rotated token when it reloads.
      var own=sessionStorage.getItem('gn_tab_identity');
      if(own!==null)return own;
      var shared=localStorage.getItem('gn_identity')||'';
      sessionStorage.setItem('gn_tab_identity',shared);return shared;
    }catch(e){return ''}},
    saveIdentity:function(token){if(typeof token==='string'&&token)try{sessionStorage.removeItem('gn_login_blocked');sessionStorage.setItem('gn_tab_identity',token);localStorage.setItem('gn_identity',token)}catch(e){}},
    invalidateIdentity:function(expected){try{
      sessionStorage.setItem('gn_login_blocked','1');sessionStorage.setItem('gn_tab_identity','');
      if(!expected||localStorage.getItem('gn_identity')===expected){localStorage.removeItem('gn_identity');api.clear();}
      else mirror(null);
    }catch(e){}},
    // Returns { roomId, resumeToken, playerIndex, game } or null (expired data is cleared).
    get: function(now) {
      var d = read();
      if (!d) return null;
      if (typeof d.savedAt !== 'number' || (now || Date.now()) - d.savedAt > TTL) { api.clear(); return null; }
      mirror(d);
      return d;
    },
    set: function(fields) {
      var d = read() || {};
      FIELDS.forEach(function(k) { if (fields && fields[k] != null) d[k] = fields[k]; });
      d.savedAt = Date.now();
      write(d);
      mirror(d);
    },
    // Refresh the timestamp so a long game does not expire the seat; throttled to one write per 30s.
    touch: function() {
      var n = Date.now();
      if (n - lastTouch < 30000) return;
      lastTouch = n;
      var d = read();
      if (!d) return;
      d.savedAt = n;
      write(d);
    },
    clear: function() {
      var l = ls();
      if (l) { try { l.removeItem(KEY); } catch (e) {} }
      mirror(null);
    },
    // name 1-8 chars after trim, avatar 1-4 chars (mirrors the server's set_name / set_avatar rules)
    validName: function(v) { return typeof v === 'string' && v.trim().length > 0 && [...v.trim()].length <= 16 ? v.trim() : null; },
    validAvatar: function(v) { return typeof v === 'string' && v.length > 0 && v.length <= 4 ? v : null; },
    getProfile: function() {
      var l = ls(), name = null, avatar = null;
      if (l) {
        try { name = api.validName(l.getItem('gn_name')); } catch (e) {}
        try { avatar = api.validAvatar(l.getItem('gn_avatar')); } catch (e) {}
      }
      return { name: name, avatar: avatar };
    },
    saveName: function(v) {
      var n = api.validName(v), l = ls();
      if (n && l) { try { l.setItem('gn_name', n); } catch (e) {} }
    },
    saveAvatar: function(v) {
      var a = api.validAvatar(v), l = ls();
      if (a && l) { try { l.setItem('gn_avatar', a); } catch (e) {} }
    },
    // Send the remembered profile for a seat that was just created (still has the server defaults).
    sendProfile: function(ws) {
      var p = api.getProfile();
      try {
        if (p.name) ws.send(JSON.stringify({ type: 'set_name', data: { name: p.name } }));
        if (p.avatar) ws.send(JSON.stringify({ type: 'set_avatar', data: { avatar: p.avatar } }));
      } catch (e) {}
    }
  };

  root.GNSession = api;
})(typeof window !== 'undefined' ? window : globalThis);
