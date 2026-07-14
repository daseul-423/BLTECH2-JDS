/* ===================== Firestore 데이터 서비스 (repository 계층) =====================
 * Firebase compat SDK 사용. 화면 코드는 app.js의 api()를 통해 이 계층만 호출한다.
 * 향후 DB 교체 시 이 파일만 수정하면 된다.
 *
 * 규약(기존 /api/* 와 동일한 반환 형태):
 *   list(col)            → 문서 배열
 *   create(col, obj)     → 생성된 문서(정수 id 부여 + 감사필드)
 *   update(col, id, obj) → 갱신된 문서(전체 치환)
 *   remove(col, id)      → { ok: true }
 *   getMasters()/putMasters(obj)
 * 마이그레이션 보조: listIds / importDoc / setCounterAtLeast
 */
(function () {
  'use strict';
  if (!window.firebase || !window.firebaseConfig) {
    console.error('[dataService] Firebase SDK 또는 firebase-config.js가 로드되지 않았습니다.');
    return;
  }
  firebase.initializeApp(window.firebaseConfig);
  var _db = firebase.firestore();
  var _auth = firebase.auth();

  var _who = function () { var u = _auth.currentUser; return u ? (u.email || u.uid) : null; };
  var _now = function () { return new Date().toISOString(); };

  // 정수 id 시퀀스: meta/counters 문서에서 컬렉션별로 원자적 증가 (기존 seqs 대체)
  function _nextId(col) {
    var ref = _db.collection('meta').doc('counters');
    return _db.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var cur = (snap.exists ? snap.data() : {})[col] || 0;
        var next = Number(cur) + 1;
        tx.set(ref, (function (o) { o[col] = next; return o; })({}), { merge: true });
        return next;
      });
    });
  }

  window.dataService = {
    auth: _auth,

    list: function (col) {
      return _db.collection(col).get().then(function (qs) {
        return qs.docs.map(function (d) { return d.data(); });
      });
    },
    get: function (col, id) {
      return _db.collection(col).doc(String(id)).get().then(function (d) { return d.exists ? d.data() : null; });
    },
    create: function (col, obj) {
      return _nextId(col).then(function (id) {
        var now = _now(), who = _who();
        var rec = Object.assign({}, obj, { id: id, createdBy: who, createdAt: now, updatedBy: who, updatedAt: now });
        return _db.collection(col).doc(String(id)).set(rec).then(function () { return rec; });
      });
    },
    update: function (col, id, obj) {
      // 전체 치환(기존 PUT 의미 유지). createdBy/createdAt은 obj에 실려 오면 보존됨.
      var rec = Object.assign({}, obj, { id: Number(id), updatedBy: _who(), updatedAt: _now() });
      return _db.collection(col).doc(String(id)).set(rec).then(function () { return rec; });
    },
    remove: function (col, id) {
      return _db.collection(col).doc(String(id)).delete().then(function () { return { ok: true }; });
    },
    getMasters: function () {
      return _db.collection('masters').doc('singleton').get().then(function (d) { return d.exists ? d.data() : {}; });
    },
    putMasters: function (obj) {
      return _db.collection('masters').doc('singleton').set(obj || {}).then(function () { return obj || {}; });
    },

    /* --- 마이그레이션 보조 (migrate.html 전용) --- */
    listIds: function (col) {
      return _db.collection(col).get().then(function (qs) { return qs.docs.map(function (d) { return Number(d.id); }); });
    },
    importDoc: function (col, obj) {
      return _db.collection(col).doc(String(obj.id)).set(obj);
    },
    setCounterAtLeast: function (col, n) {
      var ref = _db.collection('meta').doc('counters');
      return _db.runTransaction(function (tx) {
        return tx.get(ref).then(function (s) {
          var cur = (s.exists ? s.data() : {})[col] || 0;
          if (Number(n) > Number(cur)) tx.set(ref, (function (o) { o[col] = Number(n); return o; })({}), { merge: true });
        });
      });
    },
  };
})();
