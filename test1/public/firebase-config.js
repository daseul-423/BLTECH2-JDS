/* Firebase 웹 앱 공개 설정값 (⚠️ 비밀 아님 — 보안은 Firebase Auth + Firestore Security Rules가 담당).
 *
 * 채우는 곳: Firebase 콘솔 → 프로젝트 설정(⚙️) → 일반 → 내 앱 → "SDK 설정 및 구성" → 구성(Config)
 * 아래 값을 콘솔에 표시된 값으로 교체하세요. (storageBucket은 이 프로젝트에서 미사용)
 *
 * 이 파일은 커밋해도 됩니다(공개 설정값). 진짜 비밀(서비스계정 JSON / Admin 비밀키 / OpenAI 키)은
 * 절대 여기 넣지 마세요.
 */
window.firebaseConfig = {
  apiKey: 'AIzaSyB3ECijUZc3cUz47jJnsgsiMFeH043Q7Wk',
  authDomain: 'bltech-jds.firebaseapp.com',
  projectId: 'bltech-jds',
  storageBucket: 'bltech-jds.firebasestorage.app', // 미사용(Storage 안 씀)
  messagingSenderId: '1084640968636',
  appId: '1:1084640968636:web:2fa6a41b62e6312a0c35b9',
};
