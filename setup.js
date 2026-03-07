// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDF4f8d8TNx212N_WSpNgfv7daazHidgWo",
  authDomain: "tasksquad-e1442.firebaseapp.com",
  projectId: "tasksquad-e1442",
  storageBucket: "tasksquad-e1442.firebasestorage.app",
  messagingSenderId: "534501766322",
  appId: "1:534501766322:web:00b86d7c7175a9fd4185ab",
  measurementId: "G-NS4TFRBLBD"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);