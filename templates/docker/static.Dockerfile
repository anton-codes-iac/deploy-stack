FROM nginx:alpine

# Remove default Nginx static assets
RUN rm -rf /usr/share/nginx/html/*

# Copy your static build output (e.g., from Gatsby, React, or pure HTML)
COPY . /usr/share/nginx/html

# Dynamically update the Nginx config to use the user's chosen port
RUN sed -i 's/listen  *80;/listen {{PORT}};/g' /etc/nginx/conf.d/default.conf

EXPOSE {{PORT}}
CMD ["nginx", "-g", "daemon off;"]