// Task 7 - CI/CD pipeline: GitHub -> Jenkins -> Docker image -> Kubernetes (k3s) on AWS EC2
pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '10'))
        timeout(time: 20, unit: 'MINUTES')
    }

    // Check GitHub every 2 minutes; a new commit starts the pipeline automatically
    triggers {
        pollSCM('H/2 * * * *')
    }

    parameters {
        booleanParam(name: 'PUSH_TO_DOCKERHUB', defaultValue: false,
            description: 'Also push the image to Docker Hub (needs a Jenkins credential with id "dockerhub")')
    }

    environment {
        APP        = 'meditrack'
        IMAGE      = "meditrack:${BUILD_NUMBER}"
        NAMESPACE  = 'pbl3'
        KUBECONFIG = '/var/lib/jenkins/.kube/config'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
                sh 'git log -1 --pretty="Commit %h by %an: %s"'
            }
        }

        stage('Unit Tests') {
            steps {
                // runs `node --test` inside the "test" stage of the Dockerfile
                sh 'docker build --target test -t meditrack-test:${BUILD_NUMBER} .'
            }
        }

        stage('Build Docker Image') {
            steps {
                sh 'docker build --target runtime -t ${IMAGE} -t meditrack:latest .'
                sh 'docker images meditrack'
            }
        }

        stage('Push to Docker Hub') {
            when { expression { return params.PUSH_TO_DOCKERHUB } }
            steps {
                withCredentials([usernamePassword(credentialsId: 'dockerhub',
                        usernameVariable: 'DH_USER', passwordVariable: 'DH_PASS')]) {
                    sh '''
                        echo "$DH_PASS" | docker login -u "$DH_USER" --password-stdin
                        docker tag ${IMAGE} $DH_USER/${IMAGE}
                        docker push $DH_USER/${IMAGE}
                        docker logout
                    '''
                }
            }
        }

        stage('Deploy to Kubernetes') {
            steps {
                sh '''
                    kubectl apply -f k8s/namespace.yaml
                    sed -e "s|__IMAGE__|${IMAGE}|g" -e "s|__VERSION__|${BUILD_NUMBER}|g" k8s/deployment.yaml | kubectl apply -f -
                    kubectl apply -f k8s/service.yaml
                    kubectl -n ${NAMESPACE} rollout status deployment/${APP} --timeout=180s
                '''
            }
        }

        stage('Smoke Test') {
            steps {
                sh '''
                    for i in $(seq 1 10); do
                        if curl -fsS http://localhost:30080/health; then
                            echo
                            curl -fsS http://localhost:30080/api/info; echo
                            exit 0
                        fi
                        sleep 3
                    done
                    echo "Smoke test failed"; exit 1
                '''
            }
        }
    }

    post {
        success {
            sh 'kubectl -n ${NAMESPACE} get deployments,pods,services -o wide'
            echo "Deployed ${IMAGE} - open http://<EC2-PUBLIC-IP>:30080"
        }
        failure {
            echo 'Pipeline failed - rolling back to the previous version'
            sh 'kubectl -n ${NAMESPACE} rollout undo deployment/${APP} || true'
        }
        always {
            // keep disk usage low on the small EC2 instance: remove test images and keep only the last 3 app images
            sh '''
                docker rmi meditrack-test:${BUILD_NUMBER} 2>/dev/null || true
                docker images meditrack --format '{{.Tag}}' | grep -E '^[0-9]+$' | sort -n | head -n -3 | xargs -r -I{} docker rmi meditrack:{} || true
                docker image prune -f || true
            '''
        }
    }
}
