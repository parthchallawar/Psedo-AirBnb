(() => {
  'use strict'

  // Fetch all the forms we want to apply custom Bootstrap validation styles to
  const forms = document.querySelectorAll('.needs-validation')

  // Loop over them and prevent submission
  Array.from(forms).forEach(form => {
    form.addEventListener('submit', event => {
      if (!form.checkValidity()) {
        event.preventDefault()
        event.stopPropagation()
      }

      form.classList.add('was-validated')
    }, false)
  })
})()

document.addEventListener('DOMContentLoaded', () => {
  const heroWord = document.getElementById('heroWord')
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  if (heroWord && !reduceMotion) {
    const words = ['wake up', 'unwind', 'wander', 'arrive', 'stay a while']
    let i = 0
    setInterval(() => {
      i = (i + 1) % words.length
      heroWord.style.animation = 'none'
      void heroWord.offsetWidth
      heroWord.textContent = words[i]
      heroWord.style.animation = ''
    }, 2600)
  }
})

document.addEventListener('DOMContentLoaded', () => {
  const navbar = document.querySelector('.navbar')

  const syncNavbarState = () => {
    if (!navbar) return
    if (window.scrollY > 8) {
      navbar.classList.add('is-scrolled')
    } else {
      navbar.classList.remove('is-scrolled')
    }
  }

  syncNavbarState()
  window.addEventListener('scroll', syncNavbarState, { passive: true })

  const revealTargets = document.querySelectorAll(
    '.listing-card, .card, form, h1, h2, h3, .btns, #filters, #map, .f-info, .alert'
  )

  if (!revealTargets.length) return

  revealTargets.forEach((element, index) => {
    element.classList.add('reveal-item')
    element.style.transitionDelay = `${Math.min(index * 35, 240)}ms`
  })

  if (!('IntersectionObserver' in window)) {
    revealTargets.forEach((element) => element.classList.add('is-visible'))
    return
  }

  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        obs.unobserve(entry.target)
      })
    },
    { threshold: 0.12, rootMargin: '0px 0px -30px 0px' }
  )

  revealTargets.forEach((element) => observer.observe(element))
})