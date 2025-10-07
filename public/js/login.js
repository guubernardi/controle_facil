// Toggle password visibility
const togglePassword = document.getElementById("togglePassword")
const passwordInput = document.getElementById("password")

if (togglePassword && passwordInput) {
  togglePassword.addEventListener("click", function () {
    const type = passwordInput.getAttribute("type") === "password" ? "text" : "password"
    passwordInput.setAttribute("type", type)

    // Toggle icon (you can add different SVG icons for show/hide)
    this.classList.toggle("active")
  })
}

// Form submission handler
const loginForm = document.getElementById("loginForm")

if (loginForm) {
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault()

    const email = document.getElementById("email").value
    const password = document.getElementById("password").value
    const rememberMe = document.getElementById("rememberMe").checked

    // Add your login logic here
    console.log("Login attempt:", { email, password, rememberMe })

    // Example: You would typically send this to your backend
    // fetch('/api/login', {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify({ email, password, rememberMe })
    // })
    // .then(response => response.json())
    // .then(data => {
    //     if (data.success) {
    //         window.location.href = '/dashboard';
    //     }
    // });
  })
}

// Social login handlers
const googleBtn = document.querySelector(".google-btn")
const facebookBtn = document.querySelector(".facebook-btn")

if (googleBtn) {
  googleBtn.addEventListener("click", () => {
    console.log("Google login clicked")
    // Add Google OAuth logic here
  })
}

if (facebookBtn) {
  facebookBtn.addEventListener("click", () => {
    console.log("Facebook login clicked")
    // Add Facebook OAuth logic here
  })
}
