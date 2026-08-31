# Stage 1: Build the Rails application
FROM ruby:3.3-alpine AS builder
WORKDIR /app

# Install native build tools required to compile C extensions (like pg or nokogiri)
RUN apk update && \
    apk add --no-cache build-base postgresql-dev tzdata nodejs yarn

COPY Gemfile Gemfile.lock* ./

# Use ENV to guarantee Bundler skips dev/test gems
ENV BUNDLE_WITHOUT="development:test"

# Install deps and remove cache
RUN bundle install && \
    rm -rf /usr/local/bundle/cache/*.gem

COPY . .

# Precompile assets (we use a dummy key since it's just for building)
RUN SECRET_KEY_BASE=dummy bundle exec rails assets:precompile || true

# Stage 2: Production runner
FROM ruby:3.3-alpine AS runner
WORKDIR /app

ENV RAILS_ENV=production \
    RAILS_SERVE_STATIC_FILES=true \
    RAILS_LOG_TO_STDOUT=true \
    BUNDLE_WITHOUT="development:test" \
    PORT={{PORT}}

# Upgrade Alpine OS to patch system CVEs and install runtime libs
# The pure Ruby Alpine image has no NPM/Yarn ghosts to vaporize!
RUN apk update && apk upgrade --no-cache && \
    apk add --no-cache postgresql-libs tzdata && \
    rm -rf /var/cache/apk/*

# Create unprivileged user
RUN addgroup -g 1001 -S railsgroup && \
    adduser -S railsuser -u 1001 -G railsgroup

# Copy built gems and application code
COPY --from=builder --chown=railsuser:railsgroup /usr/local/bundle /usr/local/bundle
COPY --from=builder --chown=railsuser:railsgroup /app /app

USER railsuser
EXPOSE {{PORT}}

CMD ["bundle", "exec", "puma", "-b", "tcp://0.0.0.0:{{PORT}}"]