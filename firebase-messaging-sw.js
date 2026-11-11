/* Firebase Cloud Messaging service worker for Alrafah Cash. */
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");
firebase.initializeApp({apiKey:"AIzaSyDdMd95vCyYpRlAmVBkiIrQVVpI_BdwNx0",authDomain:"alrfah-cash.firebaseapp.com",databaseURL:"https://alrfah-cash-default-rtdb.firebaseio.com",projectId:"alrfah-cash",storageBucket:"alrfah-cash.firebasestorage.app",messagingSenderId:"453873035832",appId:"1:453873035832:web:a8284aa0b33cad0b7694cd"});
const messaging=firebase.messaging();
messaging.onBackgroundMessage(payload=>{const n=payload.notification||payload.data||{},title=n.title||"الرفاه كاش",options={body:n.body||"لديك إشعار جديد",icon:"/favicon.ico",data:{url:(payload.data&&payload.data.link)||self.location.origin}};self.registration.showNotification(title,options)});
self.addEventListener("notificationclick",event=>{event.notification.close();const url=event.notification.data&&event.notification.data.url||self.location.origin;event.waitUntil(clients.matchAll({type:"window",includeUncontrolled:true}).then(list=>{for(const c of list){if("focus" in c){c.navigate(url);return c}}return clients.openWindow(url)}))});
